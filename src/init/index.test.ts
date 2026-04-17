import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as z from 'zod'

import { configSchema } from '@/config/config'

import {
  initGitRepo,
  type InitStepEvent,
  isDirectoryNonEmpty,
  isInitialized,
  runInit,
  scaffold,
  writeDockerAssets,
  writeSecrets,
} from './index'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-init-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

describe('runInit', () => {
  test('runs scaffold, install, and git steps in order', async () => {
    const events: InitStepEvent[] = []

    await runInit({ cwd: root, apiKey: 'fw_test_key', onProgress: (e) => events.push(e) })

    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual([
      'scaffold:start',
      'scaffold:done',
      'install:start',
      'install:done',
      'dockerfile:start',
      'dockerfile:done',
      'git:start',
      'git:done',
    ])
  })

  test('produces an initialized agent folder (config, secrets, markdown, git repo)', async () => {
    await runInit({ cwd: root, apiKey: 'fw_integration_key' })

    expect(isInitialized(root)).toBe(true)
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('FIREWORKS_API_KEY=fw_integration_key\n')
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(await runGit(root, ['log', '--oneline'])).toContain('Initial commit 🥚')
  })

  test('git step sees scaffolded files (step ordering)', async () => {
    await runInit({ cwd: root, apiKey: 'fw_test_key' })

    const tracked = (await runGit(root, ['ls-files'])).split('\n')
    expect(tracked).toContain('config.json')
    expect(tracked).toContain('package.json')
    expect(tracked).toContain('.gitignore')
    expect(tracked).toContain('AGENTS.md')
    expect(tracked).toContain('Dockerfile')
  })

  test('dockerfile step writes Dockerfile and reports devMode via event', async () => {
    const events: InitStepEvent[] = []

    await runInit({ cwd: root, apiKey: 'fw_test_key', onProgress: (e) => events.push(e) })

    expect(existsSync(join(root, 'Dockerfile'))).toBe(true)

    const dockerDone = events.find((e) => e.step === 'dockerfile' && e.phase === 'done')
    expect(dockerDone).toBeDefined()
    if (dockerDone && dockerDone.step === 'dockerfile' && dockerDone.phase === 'done' && dockerDone.result.ok) {
      expect(dockerDone.result.devMode).toBe(true)
    }
  })

  test('emits install result (ok or reason) in done event', async () => {
    const events: InitStepEvent[] = []

    await runInit({ cwd: root, apiKey: 'fw_test_key', onProgress: (e) => events.push(e) })

    const installDone = events.find((e) => e.step === 'install' && e.phase === 'done')
    expect(installDone).toBeDefined()
    if (installDone && installDone.step === 'install' && installDone.phase === 'done') {
      expect(typeof installDone.result.ok).toBe('boolean')
    }
  })

  test('emits git result with skipped flag in done event', async () => {
    const events: InitStepEvent[] = []

    await runInit({ cwd: root, apiKey: 'fw_test_key', onProgress: (e) => events.push(e) })

    const gitDone = events.find((e) => e.step === 'git' && e.phase === 'done')
    expect(gitDone).toBeDefined()
    if (gitDone && gitDone.step === 'git' && gitDone.phase === 'done' && gitDone.result.ok) {
      expect(gitDone.result.skipped).toBe(false)
    }
  })

  test('skips git init when .git already exists', async () => {
    await mkdir(join(root, '.git'))
    const events: InitStepEvent[] = []

    await runInit({ cwd: root, apiKey: 'fw_test_key', onProgress: (e) => events.push(e) })

    const gitDone = events.find((e) => e.step === 'git' && e.phase === 'done')
    if (gitDone && gitDone.step === 'git' && gitDone.phase === 'done' && gitDone.result.ok) {
      expect(gitDone.result.skipped).toBe(true)
    } else {
      throw new Error('expected git:done with ok result')
    }
  })

  test('works without onProgress callback', async () => {
    await runInit({ cwd: root, apiKey: 'fw_test_key' })

    expect(isInitialized(root)).toBe(true)
  })
})

describe('isDirectoryNonEmpty', () => {
  test('returns false for empty directory', () => {
    expect(isDirectoryNonEmpty(root)).toBe(false)
  })

  test('returns false when directory only contains dotfiles', async () => {
    await writeFile(join(root, '.hidden'), '')
    expect(isDirectoryNonEmpty(root)).toBe(false)
  })

  test('returns true when directory contains a regular file', async () => {
    await writeFile(join(root, 'file.txt'), '')
    expect(isDirectoryNonEmpty(root)).toBe(true)
  })

  test('returns true when directory contains a regular subdirectory', async () => {
    await mkdir(join(root, 'sub'))
    expect(isDirectoryNonEmpty(root)).toBe(true)
  })

  test('returns false for a nonexistent directory', () => {
    expect(isDirectoryNonEmpty(join(root, 'does-not-exist'))).toBe(false)
  })
})

describe('isInitialized', () => {
  test('returns false when no config.json exists', () => {
    expect(isInitialized(root)).toBe(false)
  })

  test('returns true when config.json exists', async () => {
    await writeFile(join(root, 'config.json'), '{}')
    expect(isInitialized(root)).toBe(true)
  })
})

describe('scaffold', () => {
  test('creates expected directories', async () => {
    await scaffold(root)

    for (const dir of ['workspace', 'sessions', 'memory', 'skills', '.agents/skills']) {
      const path = join(root, dir)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).isDirectory()).toBe(true)
    }
  })

  test('writes config.json with $schema reference and model, without name', async () => {
    await scaffold(root)

    const raw = await readFile(join(root, 'config.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({
      $schema: './node_modules/typeclaw/config.schema.json',
      model: 'fireworks/accounts/fireworks/routers/kimi-k2p5-turbo',
    })
  })

  test('writes config.json that passes configSchema validation', async () => {
    await scaffold(root)

    const raw = await readFile(join(root, 'config.json'), 'utf8')
    expect(() => configSchema.parse(JSON.parse(raw))).not.toThrow()
  })

  test('writes config.json that passes config.schema.json validation', async () => {
    await scaffold(root)

    const rawConfig = await readFile(join(root, 'config.json'), 'utf8')
    const rawSchema = await readFile(join(repoRoot, 'config.schema.json'), 'utf8')
    const schema = z.fromJSONSchema(JSON.parse(rawSchema))

    expect(() => schema.parse(JSON.parse(rawConfig))).not.toThrow()
  })

  test('creates empty markdown files', async () => {
    await scaffold(root)

    for (const file of ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) {
      expect(await readFile(join(root, file), 'utf8')).toBe('')
    }
  })

  test('writes a private package.json named after the folder with typeclaw as a file: dependency', async () => {
    await scaffold(root)

    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg.name).toBe(basename(root))
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe('module')
    const deps = pkg.dependencies as Record<string, string>
    expect(deps.typeclaw).toMatch(/^file:/)
    expect(pkg.scripts).toBeUndefined()
  })

  test('package.json typeclaw file: dependency points at the typeclaw repo', async () => {
    await scaffold(root)

    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const spec = pkg.dependencies.typeclaw ?? ''
    expect(spec.startsWith('file:')).toBe(true)
    const target = join(root, spec.slice('file:'.length))
    const targetPkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as { name: string }
    expect(targetPkg.name).toBe('typeclaw')
  })

  test('preserves existing package.json instead of overwriting', async () => {
    const original = '{"name":"keep-me"}\n'
    await writeFile(join(root, 'package.json'), original)

    await scaffold(root)

    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(original)
  })

  test('writes .gitignore with secret and workspace entries', async () => {
    await scaffold(root)

    const gitignore = await readFile(join(root, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.env')
    expect(gitignore).toContain('sessions/')
    expect(gitignore).toContain('memory/')
    expect(gitignore).toContain('workspace/tmp/')
  })

  test('preserves existing markdown files instead of overwriting', async () => {
    const original = '# existing content\n'
    await writeFile(join(root, 'AGENTS.md'), original)

    await scaffold(root)

    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(original)
  })

  test('preserves existing .gitignore instead of overwriting', async () => {
    const original = 'custom-entry\n'
    await writeFile(join(root, '.gitignore'), original)

    await scaffold(root)

    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(original)
  })
})

describe('initGitRepo', () => {
  test('initializes a git repo with an initial commit on main', async () => {
    await scaffold(root)

    const result = await initGitRepo(root)

    expect(result).toEqual({ ok: true, skipped: false })
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
    expect(await runGit(root, ['log', '--oneline'])).toContain('Initial commit 🥚')
  })

  test('authors the initial commit as TypeClaw', async () => {
    await scaffold(root)

    await initGitRepo(root)

    expect(await runGit(root, ['log', '-1', '--format=%an'])).toBe('TypeClaw')
    expect(await runGit(root, ['log', '-1', '--format=%ae'])).toBe('hello@typeclaw.dev')
  })

  test('respects .gitignore (does not track .env)', async () => {
    await scaffold(root)
    await writeSecrets(root, { fireworksApiKey: 'fw_test' })

    await initGitRepo(root)

    const tracked = await runGit(root, ['ls-files'])
    expect(tracked.split('\n')).not.toContain('.env')
  })

  test('skips when .git already exists', async () => {
    await scaffold(root)
    await mkdir(join(root, '.git'))

    const result = await initGitRepo(root)

    expect(result).toEqual({ ok: true, skipped: true })
  })
})

describe('writeDockerAssets', () => {
  test('writes a Dockerfile with oven/bun base image', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    expect(dockerfile).toContain('FROM oven/bun:1-slim')
    expect(dockerfile).toContain('WORKDIR /agent')
    expect(dockerfile).toContain('typeclaw')
  })

  test('returns devMode true when typeclaw dep is a file: spec', async () => {
    await scaffold(root)

    const result = await writeDockerAssets(root)

    expect(result).toEqual({ ok: true, devMode: true })
  })

  test('returns devMode false when typeclaw dep is a version range', async () => {
    await scaffold(root)
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
    ;(pkg.dependencies as Record<string, string>).typeclaw = '^0.1.0'
    await writeFile(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

    const result = await writeDockerAssets(root)

    expect(result).toEqual({ ok: true, devMode: false })
    expect(existsSync(join(root, 'Dockerfile'))).toBe(true)
  })

  test('preserves an existing Dockerfile instead of overwriting', async () => {
    await scaffold(root)
    const original = '# my custom Dockerfile\n'
    await writeFile(join(root, 'Dockerfile'), original)

    await writeDockerAssets(root)

    expect(await readFile(join(root, 'Dockerfile'), 'utf8')).toBe(original)
  })
})

describe('writeSecrets', () => {
  test('writes FIREWORKS_API_KEY to .env', async () => {
    await writeSecrets(root, { fireworksApiKey: 'fw_test_abc123' })

    expect(await readFile(join(root, '.env'), 'utf8')).toBe('FIREWORKS_API_KEY=fw_test_abc123\n')
  })

  test('overwrites an existing .env', async () => {
    await writeFile(join(root, '.env'), 'OLD=1\n')
    await writeSecrets(root, { fireworksApiKey: 'fw_new' })

    expect(await readFile(join(root, '.env'), 'utf8')).toBe('FIREWORKS_API_KEY=fw_new\n')
  })
})
