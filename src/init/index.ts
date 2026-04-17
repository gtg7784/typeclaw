import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG_FILE = 'config.json'
const SECRETS_FILE = '.env'
const GITIGNORE_FILE = '.gitignore'
const PACKAGE_FILE = 'package.json'

const MARKDOWN_FILES = ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md'] as const

const DIRECTORIES = ['workspace', 'sessions', 'memory', 'skills', '.agents/skills'] as const

const GITIGNORE_CONTENT = `.env
.env.local
node_modules/
sessions/
memory/
workspace/tmp/
workspace/downloads/
.DS_Store
`

export type InstallResult = { ok: true } | { ok: false; reason: string }
export type GitInitResult = { ok: true; skipped: boolean } | { ok: false; reason: string }
export type DockerAssetsResult = { ok: true; devMode: boolean } | { ok: false; reason: string }

export type InitStep = 'scaffold' | 'install' | 'dockerfile' | 'git'

export type InitStepEvent =
  | { step: InitStep; phase: 'start' }
  | { step: 'scaffold'; phase: 'done' }
  | { step: 'install'; phase: 'done'; result: InstallResult }
  | { step: 'dockerfile'; phase: 'done'; result: DockerAssetsResult }
  | { step: 'git'; phase: 'done'; result: GitInitResult }

export type InitOptions = {
  cwd: string
  apiKey: string
  onProgress?: (event: InitStepEvent) => void
}

export async function runInit({ cwd, apiKey, onProgress }: InitOptions): Promise<void> {
  const emit = onProgress ?? (() => {})

  emit({ step: 'scaffold', phase: 'start' })
  await scaffold(cwd)
  await writeSecrets(cwd, { fireworksApiKey: apiKey })
  emit({ step: 'scaffold', phase: 'done' })

  emit({ step: 'install', phase: 'start' })
  const install = await runBunInstall(cwd)
  emit({ step: 'install', phase: 'done', result: install })

  // TODO: supports Docker/launchctl/...
  emit({ step: 'dockerfile', phase: 'start' })
  const docker = await writeDockerAssets(cwd)
  emit({ step: 'dockerfile', phase: 'done', result: docker })

  emit({ step: 'git', phase: 'start' })
  const git = await initGitRepo(cwd)
  emit({ step: 'git', phase: 'done', result: git })
}

export function isDirectoryNonEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => !entry.startsWith('.'))
  } catch {
    return false
  }
}

export function isInitialized(dir: string): boolean {
  return existsSync(join(dir, CONFIG_FILE))
}

export async function scaffold(root: string): Promise<void> {
  await Promise.all(DIRECTORIES.map((dir) => mkdir(join(root, dir), { recursive: true })))

  // TODO: hardcoded model. Mirror src/config/index.ts until the config loader
  // and provider registry exist (TypeClaw.md Phase 1 + Phase 4).
  const config = {
    $schema: './node_modules/typeclaw/config.schema.json',
    model: 'fireworks/accounts/fireworks/routers/kimi-k2p5-turbo',
  }
  await writeFile(join(root, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`)

  const pkg = buildPackageJson(root, basename(root))
  await writeFile(join(root, PACKAGE_FILE), `${JSON.stringify(pkg, null, 2)}\n`, { flag: 'wx' }).catch(ignoreExists)

  await Promise.all(MARKDOWN_FILES.map((file) => writeFile(join(root, file), '', { flag: 'wx' }).catch(ignoreExists)))

  await writeFile(join(root, GITIGNORE_FILE), GITIGNORE_CONTENT, { flag: 'wx' }).catch(ignoreExists)
}

function buildPackageJson(root: string, name: string): Record<string, unknown> {
  const typeclawRoot = findTypeclawRoot()
  // FIXME: temporary dev-stage wiring. Switch to a published version range
  // (e.g. "typeclaw": "^x.y.z") once typeclaw is released. The `file:` spec is
  // computed relative to the agent root because `file:` resolves relative to
  // the consuming package.
  const fileSpec = typeclawRoot ? `file:${toFileSpec(relative(root, typeclawRoot))}` : 'file:../typeclaw'
  return {
    name,
    private: true,
    type: 'module',
    dependencies: {
      typeclaw: fileSpec,
    },
  }
}

function toFileSpec(rel: string): string {
  if (rel === '') return '.'
  // bun/npm accept POSIX-style paths in file: specifiers; normalize separators.
  return rel.split(/[\\/]/).join('/')
}

function findTypeclawRoot(): string | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    const root = resolve('/')
    while (dir !== root) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }
        if (pkg.name === 'typeclaw') return dir
      }
      dir = dirname(dir)
    }
  } catch {}
  return null
}

const DOCKERFILE = 'Dockerfile'

export async function writeDockerAssets(root: string): Promise<DockerAssetsResult> {
  try {
    const pkg = await readPackageJson(root)
    const typeclawSpec = pkg.dependencies?.typeclaw ?? ''
    const devMode = typeclawSpec.startsWith('file:')

    await writeFile(join(root, DOCKERFILE), buildDockerfile(), { flag: 'wx' }).catch(ignoreExists)

    return { ok: true, devMode }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function buildDockerfile(): string {
  return `FROM oven/bun:1-slim

WORKDIR /agent

# The agent folder (including node_modules) is bind-mounted at runtime by
# \`typeclaw up\`, so we do not COPY or install here. This keeps the image
# tiny and lets edits on the host take effect without rebuilds.

ENV NODE_ENV=production

ENTRYPOINT ["bun", "run", "typeclaw"]
CMD ["run"]
`
}

async function readPackageJson(root: string): Promise<{ name?: string; dependencies?: Record<string, string> }> {
  const raw = await readFile(join(root, PACKAGE_FILE), 'utf8')
  return JSON.parse(raw) as { name?: string; dependencies?: Record<string, string> }
}

export async function runBunInstall(cwd: string): Promise<InstallResult> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { ok: false, reason: 'bun runtime not available' }
  try {
    const proc = bun.spawn({
      cmd: ['bun', 'install'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code === 0) return { ok: true }
    const stderr = await new Response(proc.stderr).text()
    return { ok: false, reason: `bun install exited with code ${code}: ${stderr.trim() || 'no stderr'}` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function initGitRepo(cwd: string): Promise<GitInitResult> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { ok: false, reason: 'bun runtime not available' }

  if (existsSync(join(cwd, '.git'))) return { ok: true, skipped: true }

  // Author the initial commit as TypeClaw itself. The agent is still unnamed
  // (IDENTITY.md is empty and hatching hasn't run), so the agent identity will
  // take over from the hatching commit onward. This also avoids depending on
  // the user's global `user.name`/`user.email`.
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'TypeClaw',
    GIT_AUTHOR_EMAIL: 'hello@typeclaw.dev',
    GIT_COMMITTER_NAME: 'TypeClaw',
    GIT_COMMITTER_EMAIL: 'hello@typeclaw.dev',
  }

  try {
    const init = bun.spawn({ cmd: ['git', 'init', '-b', 'main'], cwd, env, stdout: 'pipe', stderr: 'pipe' })
    if ((await init.exited) !== 0) {
      const stderr = await new Response(init.stderr).text()
      return { ok: false, reason: `git init failed: ${stderr.trim() || 'no stderr'}` }
    }

    const add = bun.spawn({ cmd: ['git', 'add', '.'], cwd, env, stdout: 'pipe', stderr: 'pipe' })
    if ((await add.exited) !== 0) {
      const stderr = await new Response(add.stderr).text()
      return { ok: false, reason: `git add failed: ${stderr.trim() || 'no stderr'}` }
    }

    const commit = bun.spawn({
      cmd: ['git', 'commit', '-m', 'Initial commit 🥚'],
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if ((await commit.exited) !== 0) {
      const stderr = await new Response(commit.stderr).text()
      return { ok: false, reason: `git commit failed: ${stderr.trim() || 'no stderr'}` }
    }

    return { ok: true, skipped: false }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// TODO: generalize to arbitrary provider secrets and switch to secrets.json
// (per TypeClaw.md spec) once the provider registry exists. Currently hardcoded
// to FIREWORKS_API_KEY in .env to match src/agent/auth.ts.
export async function writeSecrets(root: string, { fireworksApiKey }: { fireworksApiKey: string }): Promise<void> {
  const content = `FIREWORKS_API_KEY=${fireworksApiKey}\n`
  await writeFile(join(root, SECRETS_FILE), content)
}

function ignoreExists(error: NodeJS.ErrnoException): void {
  if (error.code !== 'EEXIST') throw error
}
