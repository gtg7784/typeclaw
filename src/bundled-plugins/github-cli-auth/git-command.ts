// Plain-`git` analog of analyzeGhCommand. `gh` names its repo in argv (`-R`);
// `git` only implies it via a remote, so this RESOLVES the target repo:
// explicit github.com URL -> remote name via `git remote get-url` -> the
// branch.<cur>.pushRemote/remote.pushDefault/origin fallback chain. The slug
// feeds the same per-repo mint the `gh` path uses; the token is injected via
// GIT_ASKPASS env, never into the command string.

export type GitCommandDecision =
  | { kind: 'pass-through' }
  | { kind: 'block'; reason: string }
  // rewrittenCommand replaces the executed command: `cd <dir> && git …` becomes
  // `git -C <dir> …` so the token-bearing command stays a single bare `git`
  // (no sibling process inherits the askpass env).
  | { kind: 'inject'; repoSlug: string; rewrittenCommand?: string }

// Returns null when the remote/config is absent or git fails — the analyzer
// then passes through so git fails honestly rather than us guessing a repo.
export type GitRemoteResolver = (cwd: string, remote: string) => Promise<string | null>
export type GitConfigResolver = (cwd: string, key: string) => Promise<string | null>
export type GitBranchResolver = (cwd: string) => Promise<string | null>

export type GitResolvers = {
  resolveRemoteUrl: GitRemoteResolver
  resolveConfig: GitConfigResolver
  resolveCurrentBranch: GitBranchResolver
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return null
  try {
    const proc = bun.spawn({
      cmd: ['git', '-C', cwd, ...args],
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    const out = (await new Response(proc.stdout).text()).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

export const defaultGitResolvers: GitResolvers = {
  resolveRemoteUrl: (cwd, remote) => runGit(cwd, ['remote', 'get-url', remote]),
  resolveConfig: (cwd, key) => runGit(cwd, ['config', '--get', key]),
  resolveCurrentBranch: (cwd) => runGit(cwd, ['symbolic-ref', '--short', 'HEAD']),
}

const REMOTE_SUBCOMMANDS = new Set(['push', 'fetch', 'pull', 'clone', 'ls-remote'])

const MULTI_OWNER_REASON =
  'This git command targets repos under more than one owner; a single minted ' +
  'GitHub App token cannot authenticate all of them. Split it into separate ' +
  'commands, one owner each.'

const COMPOSITION_REASON =
  'A repo-targeting `git` command receives a minted GitHub App token via ' +
  'GIT_ASKPASS in its process environment, so it must run as a single bare ' +
  '`git` command — no `;`, `&&`, `||`, `&`, newlines, pipes, redirections, ' +
  'command/parameter substitution, or subshells (any sibling process would ' +
  'inherit the token). The one accepted prefix is `cd <simple-path> && git …`, ' +
  'which is rewritten to `git -C <path> …`.'

// OUTSIDE single quotes these spawn a sibling process (which would inherit the
// askpass token) or expand shell state. `$`/backtick stay active inside double
// quotes too, so they are screened separately. Mirrors gh-command.ts.
const SHELL_ACTIVE_METACHARS = new Set(['|', ';', '&', '\n', '\r', '(', ')', '{', '}', '<', '>', '`', '$'])

export async function analyzeGitCommand(
  command: string,
  options: { cwd: string; resolvers: GitResolvers },
): Promise<GitCommandDecision> {
  const stripped = stripSafeCdPrefix(command)
  const segment = extractSingleGitInvocation(stripped.rest)
  if (segment === null) return { kind: 'pass-through' }

  const args = segment.args
  const subcommand = findSubcommand(args)
  if (subcommand === undefined || !REMOTE_SUBCOMMANDS.has(subcommand)) return { kind: 'pass-through' }

  const dashCDir = extractDashCDir(args)
  const effectiveCwd = resolveCwd(options.cwd, dashCDir ?? stripped.cdDir)

  const slugs = await resolveRepoSlugs(subcommand, args, effectiveCwd, options.resolvers)
  if (slugs.length === 0) return { kind: 'pass-through' }

  const owners = new Set(slugs.map((s) => s.split('/')[0]))
  if (owners.size > 1) return { kind: 'block', reason: MULTI_OWNER_REASON }

  const repoSlug = slugs[0] as string

  // Injecting the askpass token into env means any sibling process inherits it,
  // so a token-bearing command must be a single bare `git`. A `cd … && git …`
  // is allowed only by rewriting away the `&&` into `git -C …`.
  if (stripped.cdDir !== null) {
    if (containsShellActiveMetachar(stripped.rest)) return { kind: 'block', reason: COMPOSITION_REASON }
    return { kind: 'inject', repoSlug, rewrittenCommand: rewriteCdToDashC(effectiveCwd, stripped.rest) }
  }
  if (containsShellActiveMetachar(command)) return { kind: 'block', reason: COMPOSITION_REASON }
  return { kind: 'inject', repoSlug }
}

async function resolveRepoSlugs(
  subcommand: string,
  args: readonly string[],
  cwd: string,
  resolvers: GitResolvers,
): Promise<string[]> {
  const explicitUrl = extractExplicitUrl(subcommand, args)
  if (explicitUrl !== null) {
    const slug = parseGithubRepoFromGitUrl(explicitUrl)
    return slug === null ? [] : [slug]
  }

  // clone needs an explicit URL; it has no configured-remote fallback.
  if (subcommand === 'clone') return []

  const remoteName = extractRemoteName(args) ?? (await resolveDefaultPushRemote(cwd, resolvers))
  if (remoteName === null) return []
  if (looksLikeUrl(remoteName)) {
    const slug = parseGithubRepoFromGitUrl(remoteName)
    return slug === null ? [] : [slug]
  }
  const url = await resolvers.resolveRemoteUrl(cwd, remoteName)
  if (url === null) return []
  const slug = parseGithubRepoFromGitUrl(url)
  return slug === null ? [] : [slug]
}

// Mirrors git's own push-remote resolution order for a bare `git push`.
async function resolveDefaultPushRemote(cwd: string, resolvers: GitResolvers): Promise<string | null> {
  const branch = await resolvers.resolveCurrentBranch(cwd)
  if (branch !== null && branch !== '') {
    const perBranch = await resolvers.resolveConfig(cwd, `branch.${branch}.pushRemote`)
    if (perBranch !== null && perBranch !== '') return perBranch
  }
  const pushDefault = await resolvers.resolveConfig(cwd, 'remote.pushDefault')
  if (pushDefault !== null && pushDefault !== '') return pushDefault
  return 'origin'
}

const HTTPS_GITHUB_RE = /^https:\/\/github\.com\/([^/\s:@]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i
const SCP_GITHUB_RE = /^git@github\.com:([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/i
const SSH_GITHUB_RE = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i

// Parses a github.com remote URL into an `owner/name` slug. Returns null for
// non-github.com hosts, credential-bearing https URLs (https://tok@github.com/…
// — we never reuse an embedded credential), local paths, or malformed input.
export function parseGithubRepoFromGitUrl(raw: string): string | null {
  const url = raw.trim()
  for (const re of [HTTPS_GITHUB_RE, SCP_GITHUB_RE, SSH_GITHUB_RE]) {
    const m = url.match(re)
    if (m === null) continue
    const owner = m[1]
    const name = m[2]
    if (owner === undefined || name === undefined || owner === '' || name === '') return null
    return `${owner}/${name}`
  }
  return null
}

function looksLikeUrl(token: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return true
  if (/^[^@\s]+@[^:\s]+:/.test(token)) return true
  return false
}

// Flags that consume the FOLLOWING token, so a remote/URL positional is not
// mistaken for a flag's value.
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '-o', '--origin', '-b', '--branch', '-u'])

function extractExplicitUrl(subcommand: string, args: readonly string[]): string | null {
  // `git push --repo <url>` / `--repo=<url>`
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--repo' || arg === '--repository') {
      const v = args[i + 1]
      if (v !== undefined && looksLikeUrl(v)) return v
    }
    if (arg.startsWith('--repo=')) return arg.slice('--repo='.length)
    if (arg.startsWith('--repository=')) return arg.slice('--repository='.length)
  }
  // First positional after the subcommand that looks like a URL.
  for (const pos of positionalsAfterSubcommand(subcommand, args)) {
    if (looksLikeUrl(pos)) return pos
  }
  return null
}

// The git subcommand is the first positional that is NOT consumed by a global
// value-flag (`git -C <dir> push`, `git -c k=v push`). A naive first-non-flag
// scan would pick the flag's value (e.g. `<dir>`) as the subcommand.
function findSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && GIT_VALUE_FLAGS.has(arg)) i += 1
      continue
    }
    return arg
  }
  return undefined
}

function extractRemoteName(args: readonly string[]): string | null {
  const sub = findSubcommand(args)
  if (sub === undefined) return null
  const positionals = positionalsAfterSubcommand(sub, args)
  const first = positionals[0]
  if (first === undefined || looksLikeUrl(first)) return null
  return first
}

function positionalsAfterSubcommand(subcommand: string, args: readonly string[]): string[] {
  const out: string[] = []
  let seenSub = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && GIT_VALUE_FLAGS.has(arg)) i += 1
      continue
    }
    if (!seenSub) {
      if (arg === subcommand) seenSub = true
      continue
    }
    out.push(arg)
  }
  return out
}

function extractDashCDir(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-C') {
      const v = args[i + 1]
      if (v !== undefined) return stripQuotes(v)
    }
  }
  return null
}

type GitInvocation = { args: string[] }

// Null unless there is exactly one `git` at command position. Composition is NOT
// rejected here — it is screened later against the original command so the block
// reason stays accurate.
function extractSingleGitInvocation(command: string): GitInvocation | null {
  const tokens = tokenize(command)
  const gitStarts: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'git') continue
    if (i === 0 || isCommandBoundaryBefore(tokens, i)) gitStarts.push(i)
  }
  if (gitStarts.length !== 1) return null
  const start = gitStarts[0] as number
  return { args: tokens.slice(start + 1).filter((t) => t !== '\n' && t !== ';' && t !== '|' && t !== '&') }
}

function isCommandBoundaryBefore(tokens: readonly string[], index: number): boolean {
  let cursor = index - 1
  while (cursor >= 0) {
    const prev = tokens[cursor]
    if (prev === undefined) return false
    if (prev === '&&' || prev === '||' || prev === '|' || prev === ';' || prev === '\n') return true
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(prev)) {
      cursor -= 1
      continue
    }
    return false
  }
  return true
}

function containsShellActiveMetachar(command: string): boolean {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (ch === '$' || ch === '`') return true
      if (ch === '"') quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (SHELL_ACTIVE_METACHARS.has(ch)) return true
  }
  return false
}

type StrippedCd = { cdDir: string | null; rest: string }

// Accepts ONLY `cd <simple-path> && git …`. <simple-path> must be a single
// token (optionally quoted) free of metachars AND of a literal single quote
// (rewriteCdToDashC single-quotes it). Any other shape returns cdDir=null, and
// the caller then requires a single bare `git`.
function stripSafeCdPrefix(command: string): StrippedCd {
  const m = command.match(/^\s*cd\s+("[^"]*"|'[^']*'|[^\s'"]+)\s+&&\s+(git\b[\s\S]*)$/)
  if (m === null) return { cdDir: null, rest: command }
  const rawDir = m[1] as string
  const rest = m[2] as string
  const dir = stripQuotes(rawDir)
  if (dir.includes('$') || dir.includes('`') || dir.includes("'") || /[;|&<>()]/.test(dir)) {
    return { cdDir: null, rest: command }
  }
  return { cdDir: dir, rest }
}

function rewriteCdToDashC(dir: string, gitCommand: string): string {
  return gitCommand.replace(/^git\b/, `git -C '${dir}'`)
}

function resolveCwd(base: string, dir: string | null): string {
  if (dir === null || dir === '') return base
  if (dir.startsWith('/')) return dir
  return `${base.replace(/\/$/, '')}/${dir}`
}

function stripQuotes(token: string): string {
  if (token.length < 2) return token
  const first = token[0]
  const last = token[token.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return token.slice(1, -1)
  return token
}

// Quote-aware; emits shell control operators as standalone tokens so
// command-boundary detection works. Mirrors gh-command.ts's tokenize.
function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasContent = false

  const flush = (): void => {
    if (hasContent) {
      tokens.push(current)
      current = ''
      hasContent = false
    }
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === undefined) continue
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasContent = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flush()
      continue
    }
    if (ch === '\n') {
      flush()
      tokens.push('\n')
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      flush()
      const next = command[i + 1]
      if ((ch === '|' && next === '|') || (ch === '&' && next === '&')) {
        tokens.push(ch + ch)
        i += 1
      } else {
        tokens.push(ch)
      }
      continue
    }
    current += ch
    hasContent = true
  }
  flush()
  return tokens
}
