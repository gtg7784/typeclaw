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
        'TypeClaw inspects path names and object reachability without reading blob contents. Only unreachable commits are path-attributable (via their root tree); any other dangling tree or blob has lost the parent that carried its path and blocks model-driven Git until Git garbage collection removes it.',
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

  const nonCommitRoots = await scanNonCommitRefRoots(agentDir, gitArgs)
  if (!nonCommitRoots.ok) return nonCommitRoots

  const index = await runGit(agentDir, gitArgs, ['ls-files', '--cached', '-z'])
  const reachablePaths = matchingCanonicalPaths(splitNul(index))

  const objects = await runGit(agentDir, gitArgs, ['rev-list', '--objects', '--all', '--reflog'])
  for (const line of objects.split('\n')) {
    const separator = line.indexOf(' ')
    if (separator >= 0) reachablePaths.push(...matchingCanonicalPaths([decodeGitPath(line.slice(separator + 1))]))
  }

  const unreachableMatches = await scanUnreachableObjects(agentDir, gitArgs)
  if (!unreachableMatches.ok) return unreachableMatches

  const matches = [...new Set([...reachablePaths, ...unreachableMatches.paths])].sort()
  if (matches.length > 0) return { ok: false, paths: matches }

  return { ok: true }
}

type UnreachableScan = { ok: false; paths: string[] } | { ok: true; paths: string[] }

// A ref or worktree HEAD pointing at (or a tag peeling to) a non-commit makes that tree/blob
// reachable, so neither fsck mode reports it and rev-list cannot root-anchor its path. Such a live
// root has no repository path prefix, so it fails closed exactly like an orphan tree. Ordinary
// commit-ish roots are handled by the reachable/reflog path scans.
async function scanNonCommitRefRoots(agentDir: string, gitArgs: readonly string[]): Promise<UnreachableScan> {
  const heads = await runGit(agentDir, gitArgs, ['worktree', 'list', '--porcelain'])
  const headRefs = heads
    .split('\n')
    .filter((line) => line.startsWith('HEAD '))
    .map((line) => line.slice('HEAD '.length).trim())
  const refs = await runGit(agentDir, gitArgs, ['for-each-ref', '--format=%(objectname)'])
  const roots = [...new Set([...headRefs, ...refs.split('\n')].map((oid) => oid.trim()))].filter(
    (oid) => oid !== '' && !/^0+$/.test(oid),
  )

  for (const root of roots) {
    const target = await peelTag(agentDir, gitArgs, root)
    if (target.type !== 'commit') return { ok: false, paths: ['unattributable dangling Git objects'] }
  }
  return { ok: true, paths: [] }
}

// Reachable objects expose their repository paths through rev-list, but unreachable objects do
// not — fsck only reports their OID and type. Only an unreachable commit is safely attributable:
// it records a repository root tree, so every descendant path is fully reconstructable and matched
// root-anchored. Everything else stays unattributable: a bare blob never stored its filename, and
// an orphan tree (or a tag pointing at a tree/blob) has lost the parent that carried its former
// prefix — its own entry names cannot reveal whether it used to sit under a canonical secret
// directory. Such objects remain readable via `git cat-file`, so any unreachable tree or blob not
// reached from a commit root fails closed until Git garbage collection removes it. Reflogs are
// excluded (`--no-reflogs`): fsck marks reflog-referenced objects reachable regardless of type, so
// honoring reflogs would hide a bare blob/tree that a reflog retains — and rev-list cannot recover
// its path either. The no-reflogs unreachable set is a superset that still routes benign
// reflog-reachable commits through commit attribution, so it does not reintroduce blanket blocking.
async function scanUnreachableObjects(agentDir: string, gitArgs: readonly string[]): Promise<UnreachableScan> {
  const fsck = await runGit(agentDir, gitArgs, ['fsck', '--unreachable', '--no-reflogs', '--no-progress'])
  const unreachable = parseUnreachableObjects(fsck)
  if (unreachable.length === 0) return { ok: true, paths: [] }

  const commits: string[] = []
  const trees = new Set<string>()
  const blobs = new Set<string>()
  for (const object of unreachable) {
    if (object.type === 'commit') commits.push(object.oid)
    else if (object.type === 'tree') trees.add(object.oid)
    else if (object.type === 'blob') blobs.add(object.oid)
    else if (object.type === 'tag') {
      const target = await peelTag(agentDir, gitArgs, object.oid)
      if (target.type === 'commit') commits.push(target.oid)
      else if (target.type === 'tree') trees.add(target.oid)
      else if (target.type === 'blob') blobs.add(target.oid)
    }
  }

  const attributed = new Set<string>()
  const matches: string[] = []
  for (const commit of commits) {
    const rootTree = (await runGit(agentDir, gitArgs, ['rev-parse', `${commit}^{tree}`])).trim()
    const entries = await runGit(agentDir, gitArgs, ['ls-tree', '-r', '-t', '-z', '--full-tree', rootTree])
    attributed.add(rootTree)
    matches.push(...collectTreeEntries(entries, attributed))
  }

  const unattributed = [...trees, ...blobs].some((oid) => !attributed.has(oid))
  if (unattributed) matches.push('unattributable dangling Git objects')

  return matches.length > 0 ? { ok: false, paths: [...new Set(matches)].sort() } : { ok: true, paths: [] }
}

type PeeledTag = { type: 'commit' | 'tree' | 'blob' | 'unknown'; oid: string }

// `<tag>^{}` recursively peels tag-of-tag chains to the final non-tag object. A malformed or cyclic
// tag makes rev-parse/cat-file exit non-zero, which throws in runGit and fails the whole scan closed.
async function peelTag(agentDir: string, gitArgs: readonly string[], tag: string): Promise<PeeledTag> {
  const oid = (await runGit(agentDir, gitArgs, ['rev-parse', `${tag}^{}`])).trim()
  const type = (await runGit(agentDir, gitArgs, ['cat-file', '-t', oid])).trim()
  if (type === 'commit' || type === 'tree' || type === 'blob') return { type, oid }
  return { type: 'unknown', oid }
}

type UnreachableObject = { type: 'commit' | 'tree' | 'blob' | 'tag'; oid: string }

function parseUnreachableObjects(fsck: string): UnreachableObject[] {
  const objects: UnreachableObject[] = []
  for (const line of fsck.split('\n')) {
    const match = /^unreachable (commit|tree|blob|tag) ([0-9a-f]{40,64})$/.exec(line.trim())
    if (match) objects.push({ type: match[1] as UnreachableObject['type'], oid: match[2] as string })
  }
  return objects
}

function collectTreeEntries(nulSeparated: string, attributed: Set<string>): string[] {
  const matches: string[] = []
  for (const entry of splitNul(nulSeparated)) {
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const meta = entry.slice(0, tab).split(/\s+/)
    const oid = meta[2]
    const path = decodeGitPath(entry.slice(tab + 1))
    if (oid !== undefined) attributed.add(oid)
    if (matchesKnownRootPath(path)) matches.push(path)
  }
  return matches
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
  return paths.filter((raw) => matchesKnownRootPath(normalizeGitPath(raw)))
}

function normalizeGitPath(raw: string): string {
  return raw.replaceAll('\\', '/').replace(/^\.\//, '')
}

function matchesKnownRootPath(raw: string): boolean {
  const path = normalizeGitPath(raw)
  if (CANONICAL_AGENT_SECRET_FILES.some((secret) => path === secret)) return true
  return CANONICAL_AGENT_SECRET_DIRS.some((dir) => path.startsWith(`${dir}/`))
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
