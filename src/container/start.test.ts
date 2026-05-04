import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { startDaemon, type Daemon } from '@/hostd/daemon'
import { buildDockerfile } from '@/init/dockerfile'
import { buildGitignore } from '@/init/gitignore'

import type { DockerExec } from './shared'
import { commitSystemFile, planStart, refreshDockerfile, refreshGitignore, start } from './start'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-start-'))
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

type ScaffoldedConfig = {
  mounts?: Array<{ name: string; path: string; readOnly?: boolean; description?: string }>
}

async function writeTypeclawConfig(dir: string, overrides: ScaffoldedConfig = {}): Promise<void> {
  const config = {
    $schema: './node_modules/typeclaw/typeclaw.schema.json',
    model: 'fireworks/accounts/fireworks/routers/kimi-k2p5-turbo',
    mounts: overrides.mounts ?? [],
  }
  await writeFile(join(dir, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`)
}

// Returns the preferred port unchanged. Lets `start` tests verify their own
// behavior without going through the real kernel via `findFreePort`.
const deterministicAllocator = async (preferred: number): Promise<number> => (preferred > 0 ? preferred : 8973)

function labelValue(runArgs: string[], key: string): string | undefined {
  for (let i = 0; i < runArgs.length - 1; i++) {
    if (runArgs[i] === '--label' && runArgs[i + 1]?.startsWith(`${key}=`)) {
      return runArgs[i + 1]!.slice(key.length + 1)
    }
  }
  return undefined
}

describe('planStart', () => {
  test('produces a docker run command with name, port publish, env-file, and agent mount', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, '.env'), 'FIREWORKS_API_KEY=fw_test\n')

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

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

  test('adds hostd HTTP control env when restart transport is available', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({
      cwd: root,
      hostPort: 8973,
      imageExists: true,
      hostdControl: { url: 'http://host.docker.internal:49123', token: 'secret', brokerToken: 'broker-secret' },
    })

    expect(plan.runArgs).toContain('-e')
    expect(plan.runArgs).toContain(`TYPECLAW_CONTAINER_NAME=${basename(root)}`)
    expect(plan.runArgs).toContain('TYPECLAW_HOSTD_URL=http://host.docker.internal:49123')
    expect(plan.runArgs).toContain('TYPECLAW_HOSTD_TOKEN=secret')
    expect(plan.runArgs).toContain('--add-host')
    expect(plan.runArgs).toContain('host.docker.internal:host-gateway')
    expect(plan.runArgs.some((arg) => arg.includes('/run/typeclaw-host'))).toBe(false)
  })

  test('groups all agents under a single "typeclaw" compose project', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(labelValue(plan.runArgs, 'com.docker.compose.project')).toBe('typeclaw')
  })

  test('uses the folder basename as the compose service name', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(labelValue(plan.runArgs, 'com.docker.compose.service')).toBe(basename(root))
  })

  test('sets compose labels required for docker compose ls and Docker Desktop grouping', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(labelValue(plan.runArgs, 'com.docker.compose.project.working_dir')).toBe(root)
    expect(labelValue(plan.runArgs, 'com.docker.compose.oneoff')).toBe('False')
    expect(labelValue(plan.runArgs, 'com.docker.compose.config-hash')).toBe('manual')
    expect(labelValue(plan.runArgs, 'com.docker.compose.container-number')).toBe('1')
  })

  test('omits --env-file when .env is missing', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).not.toContain('--env-file')
  })

  test('propagates host TZ via -e so cron schedules fire at the wall-clock the user expects', async () => {
    const original = process.env.TZ
    process.env.TZ = 'Asia/Seoul'
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      const tzIdx = plan.runArgs.findIndex((a, i) => a === '-e' && plan.runArgs[i + 1] === 'TZ=Asia/Seoul')
      expect(tzIdx).toBeGreaterThanOrEqual(0)
    } finally {
      if (original === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = original
      }
    }
  })

  test('falls back to Intl-detected timezone when TZ env var is unset (typical macOS host)', async () => {
    const original = process.env.TZ
    delete process.env.TZ
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      const eIdx = plan.runArgs.findIndex((a, i) => a === '-e' && plan.runArgs[i + 1]?.startsWith('TZ='))
      expect(eIdx).toBeGreaterThanOrEqual(0)
      const detected = plan.runArgs[eIdx + 1]?.slice('TZ='.length)
      expect(detected).toBeTruthy()
    } finally {
      if (original !== undefined) process.env.TZ = original
    }
  })

  test('adds a mirror mount for the typeclaw source when dependency is a file: spec outside cwd', async () => {
    const typeclawRepo = await mkdtemp(join(tmpdir(), 'typeclaw-repo-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: `file:${typeclawRepo}` })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      expect(plan.runArgs).toContain(`${typeclawRepo}:${typeclawRepo}:ro`)
    } finally {
      await rm(typeclawRepo, { recursive: true, force: true })
    }
  })

  test('skips mirror mount when typeclaw file: spec points inside the agent folder', async () => {
    await writeDockerfile(root)
    await mkdir(join(root, 'vendor', 'typeclaw'), { recursive: true })
    await writePackageJson(root, { typeclaw: 'file:./vendor/typeclaw' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    const mirrorMounts = plan.runArgs.filter((a) => a.endsWith(':ro'))
    expect(mirrorMounts).toHaveLength(0)
  })

  test('skips mirror mount when typeclaw dependency is a version range', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.endsWith(':ro'))).toHaveLength(0)
  })

  test('reports needsBuild based on imageExists input', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const missing = await planStart({ cwd: root, hostPort: 8973, imageExists: false })
    const present = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(missing.needsBuild).toBe(true)
    expect(present.needsBuild).toBe(false)
  })

  test('forceBuild forces a rebuild even when the image already exists', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const forced = await planStart({ cwd: root, hostPort: 8973, imageExists: true, forceBuild: true })
    const notForced = await planStart({ cwd: root, hostPort: 8973, imageExists: true, forceBuild: false })

    expect(forced.needsBuild).toBe(true)
    expect(notForced.needsBuild).toBe(false)
  })

  test('container name and image tag derive from the folder basename', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.containerName).toBe(basename(root))
    expect(plan.imageTag).toBe(`typeclaw-${basename(root)}`)
  })
})

describe('planStart mounts', () => {
  test('emits no mount flags when typeclaw.json is missing', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.includes(':/agent/mounts/'))).toHaveLength(0)
  })

  test('emits no mount flags when mounts array is empty', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { mounts: [] })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.includes(':/agent/mounts/'))).toHaveLength(0)
  })

  test('emits a -v flag for each mount, mapping to /agent/mounts/<name>', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'typeclaw-mount-target-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root, { mounts: [{ name: 'projects', path: projectDir }] })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      expect(plan.runArgs).toContain('-v')
      expect(plan.runArgs).toContain(`${projectDir}:/agent/mounts/projects`)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test('appends :ro suffix when readOnly is true', async () => {
    const notesDir = await mkdtemp(join(tmpdir(), 'typeclaw-mount-target-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root, { mounts: [{ name: 'notes', path: notesDir, readOnly: true }] })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      expect(plan.runArgs).toContain(`${notesDir}:/agent/mounts/notes:ro`)
    } finally {
      await rm(notesDir, { recursive: true, force: true })
    }
  })

  test('expands ~ to the home directory', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { mounts: [{ name: 'home-thing', path: '~/some-dir' }] })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    const home = process.env.HOME ?? ''
    expect(plan.runArgs).toContain(`${home}/some-dir:/agent/mounts/home-thing`)
  })

  test('emits mounts in declared order', async () => {
    const a = await mkdtemp(join(tmpdir(), 'typeclaw-mount-a-'))
    const b = await mkdtemp(join(tmpdir(), 'typeclaw-mount-b-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root, {
        mounts: [
          { name: 'first', path: a },
          { name: 'second', path: b },
        ],
      })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      const mountFlags = plan.runArgs.filter((arg) => arg.includes(':/agent/mounts/'))
      expect(mountFlags).toEqual([`${a}:/agent/mounts/first`, `${b}:/agent/mounts/second`])
    } finally {
      await rm(a, { recursive: true, force: true })
      await rm(b, { recursive: true, force: true })
    }
  })

  test('mount flags appear before imageTag (last positional arg)', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'typeclaw-mount-target-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root, { mounts: [{ name: 'projects', path: projectDir }] })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      expect(plan.runArgs.at(-1)).toBe(plan.imageTag)
      const mountIdx = plan.runArgs.indexOf(`${projectDir}:/agent/mounts/projects`)
      expect(mountIdx).toBeGreaterThan(-1)
      expect(mountIdx).toBeLessThan(plan.runArgs.length - 1)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test('throws when typeclaw.json is malformed JSON', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'typeclaw.json'), '{ not valid json')

    await expect(planStart({ cwd: root, hostPort: 8973, imageExists: true })).rejects.toThrow()
  })

  test('treats a typeclaw.json without a mounts field as no mounts', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(
      join(root, 'typeclaw.json'),
      `${JSON.stringify({ model: 'fireworks/accounts/fireworks/routers/kimi-k2p5-turbo' })}\n`,
    )

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.includes(':/agent/mounts/'))).toHaveLength(0)
  })

  test('throws when a mount name violates the pattern', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { mounts: [{ name: 'BadName', path: '/x' }] })

    await expect(planStart({ cwd: root, hostPort: 8973, imageExists: true })).rejects.toThrow()
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

describe('refreshGitignore', () => {
  test('overwrites a stale .gitignore with the current template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-gitignore-refresh-'))
    try {
      const stale = '# stale\nold-only-entry\n'
      await writeFile(join(dir, '.gitignore'), stale)

      await refreshGitignore(dir)

      const updated = await readFile(join(dir, '.gitignore'), 'utf8')
      expect(updated).toBe(buildGitignore())
      expect(updated).not.toBe(stale)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes the .gitignore when none exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-gitignore-refresh-'))
    try {
      await refreshGitignore(dir)

      const written = await readFile(join(dir, '.gitignore'), 'utf8')
      expect(written).toBe(buildGitignore())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

async function gitInit(cwd: string): Promise<void> {
  // The commitSystemFile path uses the user's global git config for authorship,
  // but tests can run in CI with no global user.name/user.email. Set repo-local
  // identity here so commits succeed deterministically without polluting global config.
  for (const cmd of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Test User'],
    ['config', 'user.email', 'test@example.com'],
  ]) {
    const proc = Bun.spawn({ cmd: ['git', ...cmd], cwd, stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
  }
}

describe('commitSystemFile', () => {
  test('commits the file when it is dirty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-commit-'))
    try {
      // given: a git repo with a tracked file
      await gitInit(dir)
      await writeFile(join(dir, 'Dockerfile'), 'FROM original\n')
      await runGit(dir, ['add', 'Dockerfile'])
      await runGit(dir, ['commit', '-m', 'initial'])
      // and: the file is now modified (dirty)
      await writeFile(join(dir, 'Dockerfile'), 'FROM updated\n')

      // when
      await commitSystemFile(dir, 'Dockerfile', 'Update Dockerfile')

      // then: HEAD points at the new commit with the new content
      const subject = await runGit(dir, ['log', '-1', '--format=%s'])
      expect(subject).toBe('Update Dockerfile')
      const tree = await runGit(dir, ['show', 'HEAD:Dockerfile'])
      expect(tree).toBe('FROM updated')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips silently when the file is clean (no changes since last commit)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-commit-clean-'))
    try {
      // given: a committed file with no pending changes
      await gitInit(dir)
      await writeFile(join(dir, 'Dockerfile'), 'FROM clean\n')
      await runGit(dir, ['add', 'Dockerfile'])
      await runGit(dir, ['commit', '-m', 'initial'])
      const headBefore = await runGit(dir, ['rev-parse', 'HEAD'])

      // when
      await commitSystemFile(dir, 'Dockerfile', 'Update Dockerfile')

      // then: HEAD has not moved
      const headAfter = await runGit(dir, ['rev-parse', 'HEAD'])
      expect(headAfter).toBe(headBefore)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips silently when the directory is not a git repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-commit-nogit-'))
    try {
      // given: NO git init, but a Dockerfile exists
      await writeFile(join(dir, 'Dockerfile'), 'FROM whatever\n')

      // when: commit is invoked
      await commitSystemFile(dir, 'Dockerfile', 'Update Dockerfile')

      // then: no .git directory was created and no error was thrown
      expect(existsSync(join(dir, '.git'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('only commits the named file, leaving other dirty files unstaged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-commit-scope-'))
    try {
      // given: two dirty tracked files
      await gitInit(dir)
      await writeFile(join(dir, 'Dockerfile'), 'FROM original\n')
      await writeFile(join(dir, 'AGENTS.md'), 'original\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await writeFile(join(dir, 'Dockerfile'), 'FROM new\n')
      await writeFile(join(dir, 'AGENTS.md'), 'user wip\n')

      // when: commit only the Dockerfile
      await commitSystemFile(dir, 'Dockerfile', 'Update Dockerfile')

      // then: HEAD's commit changed only Dockerfile, and AGENTS.md is still dirty
      const filesInLastCommit = await runGit(dir, ['show', '--name-only', '--format=', 'HEAD'])
      expect(filesInLastCommit).toBe('Dockerfile')
      const agentsContent = await readFile(join(dir, 'AGENTS.md'), 'utf8')
      expect(agentsContent).toBe('user wip\n')
      const agentsInHead = await runGit(dir, ['show', 'HEAD:AGENTS.md'])
      expect(agentsInHead).toBe('original')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

type RecordedCall = { args: string[]; dockerfileSnapshot: string | null }

type ContainerScenario = { exists: false } | { exists: true; running: boolean; rmFails?: boolean; rmStderr?: string }

function fakeDockerExec(scenario: { imageExists: boolean; container: ContainerScenario }): {
  exec: DockerExec
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  let containerState = scenario.container
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
    if (args[0] === 'inspect') {
      if (!containerState.exists) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      return { exitCode: 0, stdout: `${containerState.running}\n`, stderr: '' }
    }
    if (args[0] === 'rm') {
      if (!containerState.exists) {
        return { exitCode: 1, stdout: '', stderr: 'Error: No such container: x' }
      }
      if (containerState.rmFails) {
        return { exitCode: 1, stdout: '', stderr: containerState.rmStderr ?? 'rm failed' }
      }
      containerState = { exists: false }
      return { exitCode: 0, stdout: '', stderr: '' }
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

describe('start (composition)', () => {
  test('refreshes Dockerfile from the template on every start, even without --build', async () => {
    // given: a stale Dockerfile and an existing image (no rebuild needed)
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: up runs WITHOUT --build
    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort: deterministicAllocator })

    // then: the Dockerfile on disk was refreshed even though docker build never ran
    expect(result.ok).toBe(true)
    const onDisk = await readFile(join(root, 'Dockerfile'), 'utf8')
    expect(onDisk).toBe(buildDockerfile())
    expect(onDisk).not.toContain('FROM stale')
  })

  test('refreshes .gitignore from the template on every start', async () => {
    // given: a stale .gitignore and an existing image
    await writeFile(join(root, '.gitignore'), '# stale\nold-entry\n')
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort: deterministicAllocator })

    // then
    expect(result.ok).toBe(true)
    const onDisk = await readFile(join(root, '.gitignore'), 'utf8')
    expect(onDisk).toBe(buildGitignore())
    expect(onDisk).not.toContain('old-entry')
  })

  test('forceBuild=true also refreshes the Dockerfile so docker build sees the fresh template', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
    })

    expect(result.ok).toBe(true)
    const buildCall = calls.find((c) => c.args[0] === 'build')
    expect(buildCall).toBeDefined()
    expect(buildCall!.dockerfileSnapshot).toBe(buildDockerfile())
    expect(buildCall!.dockerfileSnapshot).not.toContain('FROM stale')
  })

  test('commits the refreshed .gitignore when the agent folder is a git repo', async () => {
    // given: an agent folder that is a git repo with a stale committed .gitignore
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), '# stale\n')
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs (refresh will rewrite .gitignore, commit should land it)
    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort: deterministicAllocator })

    // then: HEAD advanced and the new commit exists with the expected subject
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).not.toBe(headBefore)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Update .gitignore')
  })

  test('does not auto-commit Dockerfile changes (Dockerfile is gitignored, regenerated on every start)', async () => {
    // given: an agent folder following the realistic post-init shape — Dockerfile
    // is on disk but gitignored, so it was never tracked.
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs (Dockerfile is rewritten on disk, .gitignore is unchanged)
    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort: deterministicAllocator })

    // then: HEAD did not move (no Dockerfile commit, no .gitignore commit)
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).toBe(headBefore)
    // and: the Dockerfile on disk is the fresh template
    expect(await readFile(join(root, 'Dockerfile'), 'utf8')).toBe(buildDockerfile())
  })

  test('does not commit when the refresh produces no change (clean working tree)', async () => {
    // given: an agent folder where .gitignore is already at the latest template
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort: deterministicAllocator })

    // then: no new commits were created
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).toBe(headBefore)
  })

  test('can register through the current hostd without drift respawn during daemon-owned restart', async () => {
    const previousHome = process.env.TYPECLAW_HOME
    const home = await mkdtemp(join(tmpdir(), 'typeclaw-current-hostd-'))
    let daemon: Daemon | null = null
    try {
      process.env.TYPECLAW_HOME = home
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root)
      daemon = await startDaemon({ version: 'old-hostd-version', gcIntervalMs: 1_000_000 })
      const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        allocatePort: deterministicAllocator,
        cliEntry: '/nonexistent/newer-cli.ts',
        reuseCurrentHostDaemon: true,
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.hostd.state).toBe('registered')
      expect(daemon.registered()).toContain(basename(root))
    } finally {
      if (daemon) await daemon.stop().catch(() => {})
      if (previousHome === undefined) delete process.env.TYPECLAW_HOME
      else process.env.TYPECLAW_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

  test('forceBuild=false skips build entirely when image already exists', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort: deterministicAllocator })

    expect(result.ok).toBe(true)
    expect(calls.find((c) => c.args[0] === 'build')).toBeUndefined()
    expect(calls.find((c) => c.args[0] === 'run')).toBeDefined()
  })

  test('refuses to start when a container with the same name is already running', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: true },
    })

    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort: deterministicAllocator })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/already running/)
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
    expect(calls.find((c) => c.args[0] === 'rm')).toBeUndefined()
  })

  test('force-removes a stale stopped container with the same name and proceeds to docker run', async () => {
    // given: a previous --rm cleanup left a stopped container holding the name
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false },
    })

    // when
    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort: deterministicAllocator })

    // then: rm was issued before run, and run proceeded
    expect(result.ok).toBe(true)
    const rmIdx = calls.findIndex((c) => c.args[0] === 'rm' && c.args[1] === '-f')
    const runIdx = calls.findIndex((c) => c.args[0] === 'run')
    expect(rmIdx).toBeGreaterThanOrEqual(0)
    expect(runIdx).toBeGreaterThan(rmIdx)
  })

  test('tolerates "no such container" from docker rm (auto-removal finished between inspect and rm)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false, rmFails: true, rmStderr: 'Error: No such container: x' },
    })

    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort: deterministicAllocator })

    expect(result.ok).toBe(true)
    expect(calls.find((c) => c.args[0] === 'run')).toBeDefined()
  })

  test('reports a clear error when docker rm fails for a non-recoverable reason', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false, rmFails: true, rmStderr: 'permission denied' },
    })

    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort: deterministicAllocator })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/exists but is not running/)
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
  })
})

describe('start (port allocation)', () => {
  test('publishes the allocated host port mapped to the fixed container port (8973)', async () => {
    // given: the kernel says the preferred 8973 is taken, so the allocator
    // returns an ephemeral port instead
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    const allocatePort = async () => 51234

    // when
    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort })

    // then: docker run gets `-p <hostPort>:8973`, NOT `-p 8973:8973`
    expect(result.ok).toBe(true)
    const runCall = calls.find((c) => c.args[0] === 'run')
    expect(runCall).toBeDefined()
    expect(runCall!.args).toContain('51234:8973')
    expect(runCall!.args).not.toContain('51234:51234')
    if (result.ok) expect(result.hostPort).toBe(51234)
  })

  test('still uses 8973:8973 mapping when the preferred host port is free (default case)', async () => {
    // given: 8973 is free, allocator returns the preferred port unchanged
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort: deterministicAllocator })

    // then
    expect(result.ok).toBe(true)
    const runCall = calls.find((c) => c.args[0] === 'run')
    expect(runCall!.args).toContain('8973:8973')
    if (result.ok) expect(result.hostPort).toBe(8973)
  })

  test('retries with a fresh ephemeral port when docker reports a bind conflict (TOCTOU)', async () => {
    // given: a docker that fails the first run with the canonical
    // "port is already allocated" error, and succeeds on the second
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    const calls: { args: string[] }[] = []
    const exec: DockerExec = async (args) => {
      calls.push({ args })
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'No such container' }
      if (args[0] === 'run') {
        runAttempts++
        if (runAttempts === 1) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'docker: Bind for :::8973 failed: port is already allocated',
          }
        }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const ports = [8973, 49160]
    const allocatePort = async (): Promise<number> => ports.shift() ?? 0

    // when
    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort })

    // then: the second run got a different host port and succeeded
    expect(result.ok).toBe(true)
    expect(runAttempts).toBe(2)
    const runCalls = calls.filter((c) => c.args[0] === 'run')
    expect(runCalls).toHaveLength(2)
    expect(runCalls[0]!.args).toContain('8973:8973')
    expect(runCalls[1]!.args).toContain('49160:8973')
    if (result.ok) expect(result.hostPort).toBe(49160)
  })

  test('does NOT retry when docker fails for a non-port reason (e.g. permission denied)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'No such container' }
      if (args[0] === 'run') {
        runAttempts++
        return { exitCode: 125, stdout: '', stderr: 'permission denied' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({ cwd: root, preferredHostPort: 8973, exec, allocatePort: deterministicAllocator })

    expect(result.ok).toBe(false)
    expect(runAttempts).toBe(1)
    if (!result.ok) expect(result.reason).toMatch(/permission denied/)
  })
})

describe('planStart port mapping', () => {
  test('always uses CONTAINER_PORT (8973) on the container side regardless of host port', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 49160, imageExists: true })

    expect(plan.runArgs).toContain('-p')
    expect(plan.runArgs).toContain('49160:8973')
    expect(plan.hostPort).toBe(49160)
  })
})
