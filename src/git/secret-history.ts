import { CANONICAL_AGENT_SECRET_DIRS, CANONICAL_AGENT_SECRET_FILES } from '@/sandbox/canonical-secrets'

import { hooklessGitArgs } from './hookless'
import { resolveAgentGit } from './resolve-agent-git'

type ScanResult = { ok: true } | { ok: false; paths: string[] }

const contaminatedCache = new Map<string, string[]>()

export class GitSecretHistoryError extends Error {
  constructor(paths: readonly string[]) {
    super(
      [
        `Model-driven Git/bash is disabled because Git metadata is contaminated or can conceal objects: ${paths.join(', ')}.`,
        'Assume credentials in the repository were exposed and rotate them first. Purge canonical secret paths and every refs/replace entry, expire all reflogs, and run Git garbage collection to remove unreachable objects before retrying.',
        'Suggested operator sequence: rewrite/purge the affected history and replacement refs, run `git reflog expire --expire=now --all`, then `git gc --prune=now`, and restart TypeClaw before retrying.',
        'TypeClaw inspects path names and object reachability without reading blob contents. Any dangling or unreachable object blocks model-driven Git because its former path cannot be attributed safely.',
      ].join(' '),
    )
    this.name = 'GitSecretHistoryError'
  }
}

export async function assertNoCanonicalSecretsInGit(agentDir: string): Promise<void> {
  const contaminated = contaminatedCache.get(agentDir)
  if (contaminated !== undefined) throw new GitSecretHistoryError(contaminated)

  const scan = await scanCanonicalSecretsInGit(agentDir)
  if (!scan.ok) {
    contaminatedCache.set(agentDir, scan.paths)
    throw new GitSecretHistoryError(scan.paths)
  }
}

export async function scanCanonicalSecretsInGit(agentDir: string): Promise<ScanResult> {
  const layout = resolveAgentGit(agentDir)
  if (layout === null) return { ok: true }
  const gitArgs = layout.gitArgs
  const inside = await runGit(agentDir, gitArgs, ['rev-parse', '--is-inside-work-tree'])
  if (inside.trim() !== 'true') throw new GitSecretHistoryError(['Git metadata did not resolve to a work tree'])

  const replacements = await runGit(agentDir, gitArgs, ['for-each-ref', '--format=%(refname)', 'refs/replace'])
  if (replacements.trim() !== '') return { ok: false, paths: ['replacement refs exist under refs/replace'] }

  const unreachable = await runGit(agentDir, gitArgs, ['fsck', '--unreachable', '--no-reflogs', '--no-progress'])
  if (unreachable.trim() !== '') return { ok: false, paths: ['dangling or unreachable Git objects'] }

  const index = await runGit(agentDir, gitArgs, ['ls-files', '--cached', '-z'])
  const indexPaths = splitNul(index)
  const directMatches = matchingCanonicalPaths(indexPaths)

  const objects = await runGit(agentDir, gitArgs, ['rev-list', '--objects', '--all', '--reflog'])
  const historicalPaths: string[] = []
  for (const line of objects.split('\n')) {
    const separator = line.indexOf(' ')
    if (separator >= 0) historicalPaths.push(decodeGitPath(line.slice(separator + 1)))
  }
  const matches = [...new Set([...directMatches, ...matchingCanonicalPaths(historicalPaths)])].sort()
  if (matches.length > 0) return { ok: false, paths: matches }

  return { ok: true }
}

function decodeGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw
  const bytes: number[] = []
  const encoder = new TextEncoder()
  const escaped = raw.slice(1, -1)
  for (let index = 0; index < escaped.length; index += 1) {
    const character = escaped[index] as string
    if (character !== '\\') {
      bytes.push(...encoder.encode(character))
      continue
    }
    const next = escaped[++index]
    if (next === undefined) return raw
    const simple: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      '\\': 92,
    }
    const simpleByte = simple[next]
    if (simpleByte !== undefined) {
      bytes.push(simpleByte)
      continue
    }
    if (/[0-7]/.test(next)) {
      let octal = next
      while (octal.length < 3 && index + 1 < escaped.length && /[0-7]/.test(escaped[index + 1] as string)) {
        octal += escaped[++index]
      }
      bytes.push(Number.parseInt(octal, 8))
      continue
    }
    bytes.push(...encoder.encode(next))
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

export function resetGitSecretHistoryCacheForTests(): void {
  contaminatedCache.clear()
}

function matchingCanonicalPaths(paths: readonly string[]): string[] {
  return paths.filter((raw) => {
    const path = raw.replaceAll('\\', '/').replace(/^\.\//, '')
    if (CANONICAL_AGENT_SECRET_FILES.some((secret) => path === secret)) return true
    return CANONICAL_AGENT_SECRET_DIRS.some((dir) => path.startsWith(`${dir}/`))
  })
}

function splitNul(value: string): string[] {
  return value.split('\0').filter((entry) => entry !== '')
}

async function runGit(agentDir: string, gitArgs: readonly string[], args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...hooklessGitArgs(['-C', agentDir, ...gitArgs, ...args])], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode === 0) return stdout
  throw new GitSecretHistoryError([`Git metadata scan failed (${args[0] ?? 'unknown'}): ${redactGitError(stderr)}`])
}

function redactGitError(stderr: string): string {
  const firstLine = stderr.split(/\r?\n/, 1)[0]?.trim()
  return firstLine === undefined || firstLine === '' ? 'unknown Git error' : firstLine.slice(0, 200)
}
