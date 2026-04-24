import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { buildDockerfile } from '@/init/dockerfile'

import { type DockerExec, planUp, refreshDockerfile, up } from './up'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-up-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writePackageJson(dir: string, deps: Record<string, string>): Promise<void> {
  const pkg = { name: basename(dir), private: true, type: 'module', dependencies: deps }
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}

async function writeDockerfile(dir: string): Promise<void> {
  await writeFile(join(dir, 'Dockerfile'), 'FROM oven/bun:1-slim\n')
}

function labelValue(runArgs: string[], key: string): string | undefined {
  for (let i = 0; i < runArgs.length - 1; i++) {
    if (runArgs[i] === '--label' && runArgs[i + 1]?.startsWith(`${key}=`)) {
      return runArgs[i + 1]!.slice(key.length + 1)
    }
  }
  return undefined
}

describe('planUp', () => {
  test('throws a helpful error when Dockerfile is missing', async () => {
    await expect(planUp({ cwd: root, port: 8973, imageExists: true })).rejects.toThrow(/Dockerfile not found/)
  })

  test('produces a docker run command with name, port publish, env-file, and agent mount', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, '.env'), 'FIREWORKS_API_KEY=fw_test\n')

    const plan = await planUp({ cwd: root, port: 8973, imageExists: true })

    expect(plan.runArgs[0]).toBe('run')
    expect(plan.runArgs).toContain('-d')
    expect(plan.runArgs).toContain('--rm')
    expect(plan.runArgs).toContain('--name')
    expect(plan.runArgs).toContain(plan.containerName)
    expect(plan.runArgs).toContain('-p')
    expect(plan.runArgs).toContain('8973:8973')
    expect(plan.runArgs).toContain('--env-file')
    expect(plan.runArgs).toContain(join(root, '.env'))
    expect(plan.runArgs).toContain(`${root}:/agent`)
    expect(plan.runArgs.at(-1)).toBe(plan.imageTag)
  })

  test('groups all agents under a single "typeclaw" compose project', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planUp({ cwd: root, port: 8973, imageExists: true })

    expect(labelValue(plan.runArgs, 'com.docker.compose.project')).toBe('typeclaw')
  })

  test('uses the folder basename as the compose service name', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planUp({ cwd: root, port: 8973, imageExists: true })

    expect(labelValue(plan.runArgs, 'com.docker.compose.service')).toBe(basename(root))
  })

  test('sets compose labels required for docker compose ls and Docker Desktop grouping', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planUp({ cwd: root, port: 8973, imageExists: true })

    expect(labelValue(plan.runArgs, 'com.docker.compose.project.working_dir')).toBe(root)
    expect(labelValue(plan.runArgs, 'com.docker.compose.oneoff')).toBe('False')
    expect(labelValue(plan.runArgs, 'com.docker.compose.config-hash')).toBe('manual')
    expect(labelValue(plan.runArgs, 'com.docker.compose.container-number')).toBe('1')
  })

  test('omits --env-file when .env is missing', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planUp({ cwd: root, port: 8973, imageExists: true })

    expect(plan.runArgs).not.toContain('--env-file')
  })

  test('adds a mirror mount for the typeclaw source when dependency is a file: spec outside cwd', async () => {
    const typeclawRepo = await mkdtemp(join(tmpdir(), 'typeclaw-repo-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: `file:${typeclawRepo}` })

      const plan = await planUp({ cwd: root, port: 8973, imageExists: true })

      expect(plan.runArgs).toContain(`${typeclawRepo}:${typeclawRepo}:ro`)
    } finally {
      await rm(typeclawRepo, { recursive: true, force: true })
    }
  })

  test('skips mirror mount when typeclaw file: spec points inside the agent folder', async () => {
    await writeDockerfile(root)
    await mkdir(join(root, 'vendor', 'typeclaw'), { recursive: true })
    await writePackageJson(root, { typeclaw: 'file:./vendor/typeclaw' })

    const plan = await planUp({ cwd: root, port: 8973, imageExists: true })

    const mirrorMounts = plan.runArgs.filter((a) => a.endsWith(':ro'))
    expect(mirrorMounts).toHaveLength(0)
  })

  test('skips mirror mount when typeclaw dependency is a version range', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planUp({ cwd: root, port: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.endsWith(':ro'))).toHaveLength(0)
  })

  test('reports needsBuild based on imageExists input', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const missing = await planUp({ cwd: root, port: 8973, imageExists: false })
    const present = await planUp({ cwd: root, port: 8973, imageExists: true })

    expect(missing.needsBuild).toBe(true)
    expect(present.needsBuild).toBe(false)
  })

  test('forceBuild forces a rebuild even when the image already exists', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const forced = await planUp({ cwd: root, port: 8973, imageExists: true, forceBuild: true })
    const notForced = await planUp({ cwd: root, port: 8973, imageExists: true, forceBuild: false })

    expect(forced.needsBuild).toBe(true)
    expect(notForced.needsBuild).toBe(false)
  })

  test('container name and image tag derive from the folder basename', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planUp({ cwd: root, port: 8973, imageExists: true })

    expect(plan.containerName).toBe(basename(root))
    expect(plan.imageTag).toBe(`typeclaw-${basename(root)}`)
  })
})

describe('refreshDockerfile', () => {
  test('overwrites a stale Dockerfile with the current template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-'))
    try {
      const stale = 'FROM oven/bun:1-slim\n# stale, no git install\n'
      await writeFile(join(dir, 'Dockerfile'), stale)

      await refreshDockerfile(dir)

      const updated = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(updated).toBe(buildDockerfile())
      expect(updated).not.toBe(stale)
      expect(updated).toMatch(/apt-get[\s\S]+install[\s\S]+\bgit\b/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes the Dockerfile when none exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-'))
    try {
      await refreshDockerfile(dir)

      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).toBe(buildDockerfile())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

type RecordedCall = { args: string[]; dockerfileSnapshot: string | null }

function fakeDockerExec(scenario: { imageExists: boolean; containerExists: boolean }): {
  exec: DockerExec
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const exec: DockerExec = async (args, options) => {
    let dockerfileSnapshot: string | null = null
    if (options?.cwd) {
      try {
        dockerfileSnapshot = await readFile(join(options.cwd, 'Dockerfile'), 'utf8')
      } catch {
        dockerfileSnapshot = null
      }
    }
    calls.push({ args, dockerfileSnapshot })

    if (args[0] === 'image' && args[1] === 'inspect') {
      return { exitCode: scenario.imageExists ? 0 : 1, stdout: '', stderr: '' }
    }
    if (args[0] === 'ps') {
      const filter = args[3] ?? ''
      const name = filter.replace(/^name=\^/, '').replace(/\$$/, '')
      return { exitCode: 0, stdout: scenario.containerExists ? `${name}\n` : '', stderr: '' }
    }
    if (args[0] === 'build') {
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'run') {
      return { exitCode: 0, stdout: 'fake-container-id-abcdef\n', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

describe('up (composition)', () => {
  test('forceBuild=true regenerates the Dockerfile BEFORE invoking docker build', async () => {
    // given: a stale Dockerfile and an existing image
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, containerExists: false })

    // when: up runs with --build
    const result = await up({ cwd: root, port: 8973, forceBuild: true, exec })

    // then: build saw the FRESH Dockerfile, not the stale one
    expect(result.ok).toBe(true)
    const buildCall = calls.find((c) => c.args[0] === 'build')
    expect(buildCall).toBeDefined()
    expect(buildCall!.dockerfileSnapshot).toBe(buildDockerfile())
    expect(buildCall!.dockerfileSnapshot).not.toContain('FROM stale')
    expect(buildCall!.dockerfileSnapshot).toMatch(/apt-get[\s\S]+install[\s\S]+\bgit\b/)
  })

  test('forceBuild=false leaves the user-edited Dockerfile alone', async () => {
    // given: a Dockerfile the user has edited and an image that needs rebuilding (missing)
    const userEdited = 'FROM oven/bun:1-slim\n# user customization preserved\n'
    await writeFile(join(root, 'Dockerfile'), userEdited)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: false, containerExists: false })

    // when: up runs without --build (image is missing so build still happens)
    await up({ cwd: root, port: 8973, exec })

    // then: build saw the user's Dockerfile unchanged
    const buildCall = calls.find((c) => c.args[0] === 'build')
    expect(buildCall!.dockerfileSnapshot).toBe(userEdited)
  })

  test('forceBuild=false skips build entirely when image already exists', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, containerExists: false })

    const result = await up({ cwd: root, port: 8973, exec })

    expect(result.ok).toBe(true)
    expect(calls.find((c) => c.args[0] === 'build')).toBeUndefined()
    expect(calls.find((c) => c.args[0] === 'run')).toBeDefined()
  })

  test('refuses to start when a container with the same name is already running', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, containerExists: true })

    const result = await up({ cwd: root, port: 8973, exec })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/already running/)
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
  })
})
