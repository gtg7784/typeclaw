import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { SandboxPolicyError } from './errors'
import type { SandboxMount } from './policy'

const SAFE_GIT_SUBCOMMANDS = new Set([
  'add',
  'branch',
  'checkout',
  'cherry-pick',
  'commit',
  'diff',
  'log',
  'merge',
  'rebase',
  'remote',
  'reset',
  'restore',
  'rev-parse',
  'show',
  'status',
  'switch',
  'symbolic-ref',
  'tag',
  'worktree',
])

const SHELL_ACTIVE = new Set(['|', ';', '&', '\n', '\r', '(', ')', '{', '}', '<', '>', '`', '$', '\\'])

export type PrivilegedSandboxRuntime = {
  env: Record<string, string>
  mounts: SandboxMount[]
}

type StandaloneCommand = { executable: string; args: string[] }
type MountedIdentity = { birthtimeNs: bigint; ctimeNs: bigint; dev: bigint; ino: bigint }
const mountedIdentities = new WeakMap<PrivilegedSandboxRuntime, Map<string, MountedIdentity>>()
const cleanupDirs = new WeakMap<PrivilegedSandboxRuntime, Set<string>>()

export async function resolvePrivilegedSandboxRuntime(options: {
  agentDir: string
  command: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
}): Promise<PrivilegedSandboxRuntime> {
  const runtime = emptyRuntime()
  // TYPECLAW_GIT_TOKEN is set only after the auth analyzer accepts a Git command.
  // Trust that decision rather than reparsing its command with a less capable
  // detector (notably, the analyzer accepts quoted `git` executables).
  if (options.env?.TYPECLAW_GIT_TOKEN !== undefined || containsGitInvocation(options.command)) {
    runtime.env.HOME = options.agentDir
    runtime.env.GIT_CONFIG_GLOBAL = '/dev/null'
    runtime.env.GIT_CONFIG_NOSYSTEM = '1'
  }
  const parsed = parseStandaloneCommand(options.command)
  if (parsed === null) return runtime

  const homeDir = options.homeDir ?? homedir()
  const executable = unwrapBunx(parsed)
  if (executable === null) return runtime

  // These CLIs can print or upload arbitrary files. Supplying their reusable
  // auth profile to a model-controlled child would therefore make the CLI a
  // confused deputy even when the outer shell is syntactically standalone.
  if (
    executable.executable === 'gws' ||
    executable.executable === 'codex' ||
    executable.executable === 'claude' ||
    executable.executable.startsWith('agent-')
  ) {
    return runtime
  }

  if (executable.executable === 'git') {
    runtime.env.GIT_CONFIG_GLOBAL = '/dev/null'
    runtime.env.GIT_CONFIG_NOSYSTEM = '1'
    const subcommand = gitSubcommand(executable.args)
    if (subcommand === null) return runtime
    rejectNamedSubcommand(subcommand, new Set(['config', 'credential', 'credential-cache', 'credential-store']))
    if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) return runtime
    try {
      await addSanitizedGitIdentity(runtime, path.join(homeDir, '.gitconfig'))
    } catch (error) {
      await cleanupPrivilegedSandboxRuntime(runtime)
      throw error
    }
  }

  return runtime
}

function containsGitInvocation(command: string): boolean {
  return /(^|[;&|]\s*)git(?:\s|$)/.test(command.trim())
}

export async function verifyPrivilegedSandboxRuntime(runtime: PrivilegedSandboxRuntime): Promise<void> {
  const identities = mountedIdentities.get(runtime) ?? new Map()
  for (const mount of runtime.mounts) {
    if (mount.type !== 'ro-bind') continue
    const safe = await lstat(mount.source, { bigint: true })
      .then(async (stats) => {
        if (stats.isSymbolicLink()) return false
        const expected = identities.get(mount.source)
        return (
          stats.isFile() &&
          stats.nlink === 1n &&
          expected !== undefined &&
          stats.dev === expected.dev &&
          stats.ino === expected.ino &&
          stats.ctimeNs === expected.ctimeNs &&
          stats.birthtimeNs === expected.birthtimeNs
        )
      })
      .catch(() => false)
    if (!safe) {
      throw new SandboxPolicyError(`credential profile changed after validation: ${mount.source}. Refusing to run.`)
    }
  }
}

export async function cleanupPrivilegedSandboxRuntime(runtime: PrivilegedSandboxRuntime): Promise<void> {
  const dirs = cleanupDirs.get(runtime) ?? new Set()
  const outcomes = await Promise.allSettled([...dirs].map((dir) => rm(dir, { recursive: true, force: true })))
  dirs.clear()
  const failed = outcomes.find((outcome) => outcome.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}

function emptyRuntime(): PrivilegedSandboxRuntime {
  const runtime = { env: {}, mounts: [] }
  mountedIdentities.set(runtime, new Map())
  cleanupDirs.set(runtime, new Set())
  return runtime
}

function unwrapBunx(command: StandaloneCommand): StandaloneCommand | null {
  if (command.executable !== 'bunx') return command
  const args = [...command.args]
  if (args[0] === '--bun') args.shift()
  const executable = args.shift()
  return executable === undefined ? null : { executable, args }
}

function rejectNamedSubcommand(subcommand: string, denied: ReadonlySet<string>): void {
  if (denied.has(subcommand)) {
    throw new SandboxPolicyError(
      `credential or token management command \`${subcommand}\` is unavailable to model-driven bash; use a host-side login or redacted status command instead.`,
    )
  }
}

function gitSubcommand(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-C') {
      i += 1
      continue
    }
    if (arg === '-c' || arg === '--config-env' || arg.startsWith('--config-env=')) return null
    if (arg.startsWith('-')) continue
    return arg
  }
  return null
}

async function addSanitizedGitIdentity(runtime: PrivilegedSandboxRuntime, source: string): Promise<void> {
  const raw = await readFile(source, 'utf8').catch((error) => {
    if (isNotFoundError(error)) return ''
    throw error
  })
  if (raw === '') return
  const values = parseGitUserIdentity(raw)
  if (values.length === 0) return
  const dir = await mkdtemp(path.join(tmpdir(), 'typeclaw-git-identity-'))
  cleanupDirs.get(runtime)?.add(dir)
  const generated = path.join(dir, 'config')
  await writeFile(generated, `[user]\n${values.map(([key, value]) => `\t${key} = ${value}`).join('\n')}\n`, {
    flag: 'wx',
  })
  await chmod(generated, 0o600)
  const stats = await lstat(generated, { bigint: true })
  mountedIdentities.get(runtime)?.set(generated, {
    birthtimeNs: stats.birthtimeNs,
    ctimeNs: stats.ctimeNs,
    dev: stats.dev,
    ino: stats.ino,
  })
  runtime.mounts.push({ type: 'ro-bind', source: generated, dest: '/tmp/.gitconfig' })
  runtime.env.GIT_CONFIG_GLOBAL = '/tmp/.gitconfig'
}

function parseGitUserIdentity(raw: string): Array<['name' | 'email', string]> {
  const values = new Map<'name' | 'email', string>()
  let inUser = false
  for (const line of raw.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)]\s*$/)
    if (section !== null) {
      inUser = section[1]?.trim().toLocaleLowerCase() === 'user'
      continue
    }
    if (!inUser) continue
    const entry = line.match(/^\s*(name|email)\s*=\s*(.*?)\s*$/i)
    if (entry === null || entry[2] === undefined) continue
    const key = entry[1]?.toLocaleLowerCase() as 'name' | 'email'
    const value = entry[2].replaceAll('\r', '').replaceAll('\n', '').replaceAll('\0', '')
    if (value !== '') values.set(key, value)
  }
  return [...values.entries()]
}

function parseStandaloneCommand(command: string): StandaloneCommand | null {
  const words: string[] = []
  let word = ''
  let quote: "'" | '"' | null = null
  let active = false
  for (const ch of command.trim()) {
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '$' || ch === '`' || ch === '\\') return null
      else word += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      active = true
      continue
    }
    if (SHELL_ACTIVE.has(ch)) return null
    if (/\s/.test(ch)) {
      if (active) {
        words.push(word)
        word = ''
        active = false
      }
      continue
    }
    word += ch
    active = true
  }
  if (quote !== null) return null
  if (active) words.push(word)
  const executable = words.shift()
  return executable === undefined ? null : { executable, args: words }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
