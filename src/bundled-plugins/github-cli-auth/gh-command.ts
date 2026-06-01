export type GhCommandDecision =
  | { kind: 'pass-through' }
  | { kind: 'block'; reason: string }
  | { kind: 'inject'; repoSlug: string }

const MISSING_REPO_REASON =
  'This GitHub App spans multiple owners, so `gh` has no single correct token. ' +
  'Re-run with an explicit repo: `gh <cmd> -R owner/repo` (or `gh api /repos/owner/repo/...`) ' +
  'so the right installation token can be injected.'

const MULTI_OWNER_REASON =
  'This command targets repos under more than one owner; a single GH_TOKEN cannot ' +
  'authenticate all of them. Split it into separate commands, one owner each.'

// GENUINELY repo-less subcommands (account/global, no -R/--repo): they need no
// token injection and pass through. The set is intentionally minimal —
// anything not listed (label, ruleset, secret, variable, cache, run, workflow,
// release, browse, pr, issue, repo, ...) is repo-scoped and falls through to
// the block-unless-explicit-repo rule, so an App-auth `gh label list` cannot
// silently run with the wrong installation token. Classification verified
// against gh source (commands using cmdutil.EnableRepoOverride are repo-scoped).
// `gh api` is handled separately (path-based repo extraction).
const REPO_LESS_SUBCOMMANDS = new Set([
  'auth',
  'config',
  'extension',
  'alias',
  'completion',
  'gpg-key',
  'ssh-key',
  'status',
  'org',
  'gist',
  'codespace',
  'search',
  'preview',
  'accessibility',
  'attestation',
])

// A single GH_TOKEN is injected into the whole bash command's env, so every
// `gh` in a compound command shares it. That is correct only when all
// repo-targeting `gh` invocations resolve to the same owner (one App
// installation). We therefore inspect EVERY `gh` invocation, not just the
// first: a repo-targeting `gh` with no resolvable repo blocks (missing-repo),
// and invocations spanning more than one owner block (multi-owner).
export function analyzeGhCommand(command: string): GhCommandDecision {
  const tokens = tokenize(command)
  const ghStarts = findGhInvocations(tokens)
  if (ghStarts.length === 0) return { kind: 'pass-through' }

  const repoSlugs: string[] = []
  for (let i = 0; i < ghStarts.length; i++) {
    const start = ghStarts[i] as number
    const end = ghStarts[i + 1] ?? tokens.length
    const args = tokens.slice(start + 1, end)
    const segment = classifyGhSegment(args)
    if (segment.kind === 'block') return segment
    if (segment.kind === 'inject') repoSlugs.push(segment.repoSlug)
  }

  if (repoSlugs.length === 0) return { kind: 'pass-through' }
  const owners = new Set(repoSlugs.map((slug) => slug.split('/')[0]))
  if (owners.size > 1) return { kind: 'block', reason: MULTI_OWNER_REASON }
  return { kind: 'inject', repoSlug: repoSlugs[0] as string }
}

function classifyGhSegment(args: readonly string[]): GhCommandDecision {
  const subcommand = args.find((t) => !t.startsWith('-'))
  if (subcommand === undefined) return { kind: 'pass-through' }

  const explicit = extractRepoFlag(args)
  if (explicit !== null) return { kind: 'inject', repoSlug: explicit }

  if (subcommand === 'api') {
    const apiRepo = extractRepoFromApiPath(args)
    if (apiRepo !== null) return { kind: 'inject', repoSlug: apiRepo }
    return { kind: 'pass-through' }
  }

  if (REPO_LESS_SUBCOMMANDS.has(subcommand)) return { kind: 'pass-through' }

  return { kind: 'block', reason: MISSING_REPO_REASON }
}

function findGhInvocations(tokens: readonly string[]): number[] {
  const starts: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'gh') continue
    // Skip leading `FOO=bar` env assignments; a `gh` is an invocation only at
    // the start of a simple command (command position).
    if (i === 0 || isCommandBoundaryBefore(tokens, i)) starts.push(i)
  }
  return starts
}

function isCommandBoundaryBefore(tokens: readonly string[], index: number): boolean {
  let cursor = index - 1
  while (cursor >= 0) {
    const prev = tokens[cursor]
    if (prev === undefined) return false
    if (prev === '&&' || prev === '||' || prev === '|' || prev === ';') return true
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(prev)) {
      cursor -= 1
      continue
    }
    return false
  }
  return true
}

function extractRepoFlag(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === '-R' || arg === '--repo') {
      const value = args[i + 1]
      if (value !== undefined && isRepoSlug(value)) return value
    }
    if (arg.startsWith('--repo=')) {
      const value = arg.slice('--repo='.length)
      if (isRepoSlug(value)) return value
    }
    if (arg.startsWith('-R=')) {
      const value = arg.slice('-R='.length)
      if (isRepoSlug(value)) return value
    }
  }
  return null
}

// `gh api` flags that consume the FOLLOWING token as their value. The endpoint
// is the first positional arg that is neither a flag nor a flag's value; only
// THAT arg is parsed for owner/repo. Scanning every arg (as before) would let a
// `-f q=/repos/a/b` field value or `--jq` expression masquerade as the target.
const GH_API_VALUE_FLAGS = new Set([
  '-X',
  '--method',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '-H',
  '--header',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--input',
  '--cache',
  '-i',
  '--include',
  '--hostname',
])

function extractRepoFromApiPath(args: readonly string[]): string | null {
  const apiIndex = args.indexOf('api')
  if (apiIndex === -1) return null
  for (let i = apiIndex + 1; i < args.length; i++) {
    const arg = args[i] as string
    if (arg.startsWith('-')) {
      // `--flag=value` carries its own value; bare value-flags consume the next
      // token, so skip it too.
      if (!arg.includes('=') && GH_API_VALUE_FLAGS.has(arg)) i += 1
      continue
    }
    const normalized = arg.startsWith('/') ? arg.slice(1) : arg
    const segments = normalized.split('/')
    if (segments[0] === 'repos' && segments[1] !== undefined && segments[2] !== undefined) {
      const slug = `${segments[1]}/${segments[2]}`
      if (isRepoSlug(slug)) return slug
    }
    // The endpoint is the first positional; if it isn't a /repos/{o}/{r} path,
    // there is no repo target to extract.
    return null
  }
  return null
}

function isRepoSlug(value: string): boolean {
  const [owner, name, ...rest] = value.split('/')
  return owner !== undefined && owner !== '' && name !== undefined && name !== '' && rest.length === 0
}

// Splits on whitespace AND shell control operators (; | & && ||) so a boundary
// like `true; gh ...` (no surrounding spaces) yields a standalone operator
// token. Quote-aware: operators inside quotes are literal. This is a
// command-position detector, not a full shell parser — it does not interpret
// redirections, subshells, or backgrounding semantics beyond boundary marking.
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
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      flush()
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
