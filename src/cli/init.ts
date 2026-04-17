import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cancel, confirm, intro, isCancel, outro, password, spinner } from '@clack/prompts'
import { defineCommand } from 'citty'

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

export const init = defineCommand({
  meta: {
    name: 'init',
    description: 'initialize a new typeclaw agent in the current directory',
  },
  async run() {
    const cwd = process.cwd()

    if (existsSync(join(cwd, CONFIG_FILE))) {
      console.error(`TypeClaw is already initialized in ${cwd}.`)
      process.exit(1)
    }

    if (isDirectoryNonEmpty(cwd)) {
      const proceed = await confirm({
        message: `You're at ${cwd}. The directory is not empty. Do you want to proceed?`,
        initialValue: false,
      })
      if (isCancel(proceed) || !proceed) {
        cancel('Aborted.')
        process.exit(0)
      }
    }

    intro('Initializing TypeClaw...')

    // TODO: provider/model selection. For now we assume Fireworks + Kimi K2.5 Turbo
    // because that's the only provider wired up in src/agent/auth.ts and src/config.
    // Expand to a provider picker (OpenAI, Anthropic, Fireworks, ...) once the
    // provider abstraction lands (see TypeClaw.md Phase 4).
    const apiKey = await password({
      message: 'Put your Fireworks API key',
      validate: (value) => (value && value.length > 0 ? undefined : 'API key is required'),
    })
    if (isCancel(apiKey)) {
      cancel('Aborted.')
      process.exit(0)
    }

    // TODO: add remaining wizard steps from TypeClaw.md once their runtime lands:
    //   - run method (Docker / launchctl) — Phase 3
    //   - git backup (url + PAT) — Phase 10
    //   - cron.json scaffolding — Phase 9
    //   - compose.yml registration in $HOME/.typeclaw — Phase 12
    const s = spinner()
    s.start('Laying the egg...')
    try {
      await scaffold(cwd)
      await writeSecrets(cwd, { fireworksApiKey: apiKey })
    } catch (error) {
      s.stop('Failed to initialize.')
      console.error(error)
      process.exit(1)
    }
    s.stop('Egg laid. 🥚')

    const installSpinner = spinner()
    installSpinner.start('Installing dependencies with bun...')
    const result = await runBunInstall(cwd)
    if (result.ok) {
      installSpinner.stop('Dependencies installed.')
    } else {
      installSpinner.stop(`Skipped bun install: ${result.reason}`)
    }

    const gitSpinner = spinner()
    gitSpinner.start('Initializing git repository...')
    const gitResult = await initGitRepo(cwd)
    if (gitResult.ok) {
      gitSpinner.stop(gitResult.skipped ? 'Git repository already exists.' : 'Git repository initialized.')
    } else {
      gitSpinner.stop(`Skipped git init: ${gitResult.reason}`)
    }

    outro('Continue with `typeclaw tui` or `typeclaw up`.')
  },
})

export function isDirectoryNonEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => !entry.startsWith('.'))
  } catch {
    return false
  }
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

type InstallResult = { ok: true } | { ok: false; reason: string }

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

type GitInitResult = { ok: true; skipped: boolean } | { ok: false; reason: string }

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
