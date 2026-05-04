import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { config, configSchema, type Config } from '@/config'
import { start } from '@/container'
import { createTui } from '@/tui'

import { buildDockerfile, DOCKERFILE } from './dockerfile'
import { buildGitignore, GITIGNORE_FILE } from './gitignore'
import { HATCHING_PROMPT } from './hatching'

const CONFIG_FILE = 'typeclaw.json'
const CRON_FILE = 'cron.json'
const SECRETS_FILE = '.env'
const PACKAGE_FILE = 'package.json'

const MARKDOWN_FILES = ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md'] as const

const DIRECTORIES = ['workspace', 'sessions', '.agents/skills', 'mounts'] as const

export type InstallResult = { ok: true } | { ok: false; reason: string }
export type GitInitResult = { ok: true; skipped: boolean } | { ok: false; reason: string }
export type DockerAssetsResult = { ok: true; devMode: boolean } | { ok: false; reason: string }
export type HatchingResult = { ok: true } | { ok: false; reason: string }

export type InitStep = 'scaffold' | 'install' | 'dockerfile' | 'git' | 'hatching'

export type InitStepEvent =
  | { step: 'scaffold'; phase: 'start' }
  | { step: 'scaffold'; phase: 'done' }
  | { step: 'install'; phase: 'start' }
  | { step: 'install'; phase: 'done'; result: InstallResult }
  | { step: 'dockerfile'; phase: 'start' }
  | { step: 'dockerfile'; phase: 'done'; result: DockerAssetsResult }
  | { step: 'git'; phase: 'start' }
  | { step: 'git'; phase: 'done'; result: GitInitResult }
  | { step: 'hatching'; phase: 'start' }
  | { step: 'hatching'; phase: 'done'; result: HatchingResult }

export type HatchRunner = (options: { cwd: string; port: number }) => Promise<HatchingResult>

export type InitOptions = {
  cwd: string
  apiKey: string
  discordBotToken?: string
  discordAllowAll?: boolean
  slackBotToken?: string
  slackAppToken?: string
  slackAllowAll?: boolean
  onProgress?: (event: InitStepEvent) => void
  runHatching?: HatchRunner
}

export async function runInit({
  cwd,
  apiKey,
  discordBotToken,
  discordAllowAll = true,
  slackBotToken,
  slackAppToken,
  slackAllowAll = true,
  onProgress,
  runHatching = defaultRunHatching,
}: InitOptions): Promise<void> {
  const emit = onProgress ?? (() => {})

  const wantsDiscord = discordBotToken !== undefined && discordBotToken !== ''
  const wantsSlack = slackBotToken !== undefined && slackBotToken !== ''
  emit({ step: 'scaffold', phase: 'start' })
  await scaffold(cwd, {
    withDiscord: wantsDiscord,
    discordAllowAll,
    withSlack: wantsSlack,
    slackAllowAll,
  })
  await writeSecrets(cwd, { fireworksApiKey: apiKey, discordBotToken, slackBotToken, slackAppToken })
  emit({ step: 'scaffold', phase: 'done' })

  emit({ step: 'install', phase: 'start' })
  const install = await runBunInstall(cwd)
  emit({ step: 'install', phase: 'done', result: install })

  emit({ step: 'dockerfile', phase: 'start' })
  const docker = await writeDockerAssets(cwd)
  emit({ step: 'dockerfile', phase: 'done', result: docker })

  emit({ step: 'git', phase: 'start' })
  const git = await initGitRepo(cwd)
  emit({ step: 'git', phase: 'done', result: git })

  emit({ step: 'hatching', phase: 'start' })
  const hatching = await runHatching({ cwd, port: config.port })
  emit({ step: 'hatching', phase: 'done', result: hatching })
}

async function defaultRunHatching({ cwd, port }: { cwd: string; port: number }): Promise<HatchingResult> {
  try {
    const launch = await start({ cwd, preferredHostPort: port })
    if (!launch.ok) return { ok: false, reason: launch.reason }

    // start() may have allocated a different host port (the preferred one was
    // bound). Use the actually-published port for the TUI handshake instead of
    // the preferred port, otherwise we'd connect to the wrong service.
    const hostPort = launch.hostPort

    await waitForAgent(`http://localhost:${hostPort}`, { timeoutMs: 30_000 })

    const tui = createTui({
      url: `ws://localhost:${hostPort}`,
      initialPrompt: HATCHING_PROMPT,
    })
    await tui.run()
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// Probe the server's plain HTTP fallback (non-upgrade requests get a 200 with
// body "typeclaw agent") instead of opening a WebSocket. Opening a WS here
// would trigger createSession on the server and burn an LLM session just to
// learn the port is up.
async function waitForAgent(httpUrl: string, { timeoutMs }: { timeoutMs: number }): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(httpUrl)
      if (res.status === 200) return
      lastError = new Error(`unexpected status ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for agent at ${httpUrl}: ${lastError instanceof Error ? lastError.message : ''}`)
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

// Walks upward from `start` looking for the agent folder (the dir containing
// typeclaw.json). Returns the found dir, or null if nothing is found before
// the walk hits a stop boundary.
//
// Stop boundaries (whichever comes first, checked at every level):
//   1. The current dir contains typeclaw.json — return it.
//   2. The current dir contains .git — return null. A .git boundary marks a
//      project root; refusing to cross it prevents accidentally picking up an
//      unrelated parent project, and matches how typeclaw itself initializes
//      one .git per agent folder.
//   3. We've reached the filesystem root — return null.
//
// The `.git` check fires AFTER the typeclaw.json check at the same level so
// that walking up from a subdir of the agent (e.g. `<agent>/workspace/`) still
// resolves to the agent root, even though the agent root itself contains both
// typeclaw.json and .git.
export function findAgentDir(start: string): string | null {
  let dir = resolve(start)
  const root = resolve(dir, '/')
  while (true) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir
    if (existsSync(join(dir, '.git'))) return null
    if (dir === root) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const HATCHED_COMMIT_SUBJECT = 'Hatched 🐣'

export async function isHatched(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, '.git'))) return false
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return false
  try {
    const proc = bun.spawn({ cmd: ['git', 'log', '--format=%s'], cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    if ((await proc.exited) !== 0) return false
    const subjects = (await new Response(proc.stdout).text()).split('\n')
    return subjects.includes(HATCHED_COMMIT_SUBJECT)
  } catch {
    return false
  }
}

export type ScaffoldOptions = {
  withDiscord?: boolean
  discordAllowAll?: boolean
  withSlack?: boolean
  slackAllowAll?: boolean
}

export async function scaffold(root: string, options: ScaffoldOptions = {}): Promise<void> {
  await Promise.all(DIRECTORIES.map((dir) => mkdir(join(root, dir), { recursive: true })))

  // TODO: hardcoded model. Mirror src/config/index.ts until the config loader
  // and provider registry exist (TypeClaw.md Phase 1 + Phase 4).
  //
  // Only fields without sensible defaults elsewhere are emitted. `mounts`
  // defaults to `[]` in configSchema, and the bundled memory plugin owns its
  // own defaults in plugins/memory/index.ts — re-emitting either here would
  // be duplicate noise the user has to maintain in sync with the source of
  // truth.
  const config: Record<string, unknown> = {
    $schema: './node_modules/typeclaw/typeclaw.schema.json',
    model: 'fireworks/accounts/fireworks/routers/kimi-k2p5-turbo',
  }
  const channels: Record<string, { allow: string[] }> = {}
  if (options.withDiscord) channels['discord-bot'] = { allow: options.discordAllowAll === false ? [] : ['*'] }
  if (options.withSlack) channels['slack-bot'] = { allow: options.slackAllowAll === false ? [] : ['*'] }
  if (Object.keys(channels).length > 0) config.channels = channels
  await writeFile(join(root, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`)

  const cron = {
    $schema: './node_modules/typeclaw/cron.schema.json',
    jobs: [],
  }
  await writeFile(join(root, CRON_FILE), `${JSON.stringify(cron, null, 2)}\n`, { flag: 'wx' }).catch(ignoreExists)

  const pkg = buildPackageJson(root, basename(root))
  await writeFile(join(root, PACKAGE_FILE), `${JSON.stringify(pkg, null, 2)}\n`, { flag: 'wx' }).catch(ignoreExists)

  await Promise.all(MARKDOWN_FILES.map((file) => writeFile(join(root, file), '', { flag: 'wx' }).catch(ignoreExists)))

  await writeFile(join(root, GITIGNORE_FILE), buildGitignore(), { flag: 'wx' }).catch(ignoreExists)
}

// agent-browser ships in every agent: the bundled SKILL.md (src/skills/
// agent-browser/SKILL.md) is a discovery stub that calls `agent-browser
// skills get core` at runtime, so the CLI must be installed for the skill
// to function. The Dockerfile pre-downloads Chromium too, so the agent
// can drive a browser without any first-run setup.
const AGENT_BROWSER_VERSION = '^0.26.0'

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
      'agent-browser': AGENT_BROWSER_VERSION,
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

export async function writeDockerAssets(root: string): Promise<DockerAssetsResult> {
  try {
    const pkg = await readPackageJson(root)
    const typeclawSpec = pkg.dependencies?.typeclaw ?? ''
    const devMode = typeclawSpec.startsWith('file:')

    const typeclawConfig = await readTypeclawConfig(root)
    await writeFile(join(root, DOCKERFILE), buildDockerfile(typeclawConfig.dockerfile), { flag: 'wx' }).catch(
      ignoreExists,
    )

    return { ok: true, devMode }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function readPackageJson(root: string): Promise<{ name?: string; dependencies?: Record<string, string> }> {
  const raw = await readFile(join(root, PACKAGE_FILE), 'utf8')
  return JSON.parse(raw) as { name?: string; dependencies?: Record<string, string> }
}

async function readTypeclawConfig(root: string): Promise<Config> {
  try {
    const raw = await readFile(join(root, CONFIG_FILE), 'utf8')
    return configSchema.parse(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return configSchema.parse({})
    throw error
  }
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
// to FIREWORKS_API_KEY in .env to match src/agent/auth.ts. Optional channel
// adapter tokens (DISCORD_BOT_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN) are
// appended when provided.
export async function writeSecrets(
  root: string,
  {
    fireworksApiKey,
    discordBotToken,
    slackBotToken,
    slackAppToken,
  }: {
    fireworksApiKey: string
    discordBotToken?: string
    slackBotToken?: string
    slackAppToken?: string
  },
): Promise<void> {
  const lines = [`FIREWORKS_API_KEY=${fireworksApiKey}`]
  if (discordBotToken !== undefined && discordBotToken !== '') {
    lines.push(`DISCORD_BOT_TOKEN=${discordBotToken}`)
  }
  if (slackBotToken !== undefined && slackBotToken !== '') {
    lines.push(`SLACK_BOT_TOKEN=${slackBotToken}`)
  }
  if (slackAppToken !== undefined && slackAppToken !== '') {
    lines.push(`SLACK_APP_TOKEN=${slackAppToken}`)
  }
  await writeFile(join(root, SECRETS_FILE), `${lines.join('\n')}\n`)
}

function ignoreExists(error: NodeJS.ErrnoException): void {
  if (error.code !== 'EEXIST') throw error
}
