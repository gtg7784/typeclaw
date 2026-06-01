export type GhCommandDecision =
  | { kind: 'pass-through' }
  | { kind: 'block'; reason: string }
  // `rewrittenCommand`, when present, MUST replace the executed command: `gh api`
  // rejects `-R/--repo` ("unknown shorthand flag"), so for a graphql endpoint the
  // flag is consumed as our repo hint and stripped before exec. Other inject paths
  // (REST, non-`api` subcommands) leave the command unchanged and omit it.
  | { kind: 'inject'; repoSlug: string; rewrittenCommand?: string }

const MISSING_REPO_REASON =
  'This GitHub App spans multiple owners, so `gh` has no single correct token. ' +
  'Re-run with an explicit repo: `gh <cmd> -R owner/repo` (or `gh api /repos/owner/repo/...`) ' +
  'so the right installation token can be injected.'

const MULTI_OWNER_REASON =
  'This command targets repos under more than one owner; a single GH_TOKEN cannot ' +
  'authenticate all of them. Split it into separate commands, one owner each.'

const API_REPO_CONFLICT_REASON =
  'This `gh api` call names a repo in its endpoint path that differs from its ' +
  '`-R/--repo` flag. `gh api` ignores `-R` for a literal `/repos/{owner}/{repo}` ' +
  'endpoint — the path is where the request actually goes — so the flag cannot be ' +
  'used to mint a token for one repo while hitting another. Drop the mismatched ' +
  '`-R`, or target the repo named in the path.'

// A gh segment can legitimately touch more than one repo (a `gh api` compare
// endpoint references both the base repo and a cross-fork head). The classifier
// returns EVERY effective target so analyzeGhCommand can allowlist-check and
// same-owner-check all of them — a single-slug return is what let a literal
// `gh api /repos/x/y` path slip past an `-R`-derived check.
type GhSegmentDecision =
  | { kind: 'pass-through' }
  | { kind: 'block'; reason: string }
  // `stripRepoFlag` marks a graphql inject whose `-R/--repo` is a TypeClaw-only
  // hint that `gh api` would reject, so it must be removed from the command.
  | { kind: 'inject'; repoSlugs: readonly string[]; stripRepoFlag?: boolean }

const COMPOSITION_REASON =
  'A repo-targeting `gh` command receives a minted GitHub App token in its process ' +
  'environment, so it must run as a single bare `gh` command — no pipes, `;`, `&&`, ' +
  '`||`, `&`, newlines, redirections, command/process substitution, subshells, heredocs, ' +
  'or unquoted `$` expansion (any sibling process or expansion would inherit the token ' +
  'and could exfiltrate it). jq/JSON metacharacters are fine INSIDE single quotes, e.g. ' +
  "`gh api repos/o/r --jq '.[] | {id}'`. To feed JSON to `gh api`, write it to a temp " +
  'file and use `gh api --input <file>`.'

// Shell-active metacharacters that, OUTSIDE single quotes, either spawn another
// process sharing the shell env (where the minted GH_TOKEN lives) or expand
// shell state into an argument. `|;&` = pipeline/sequence/background; newline/CR
// = command separators; `()` `{}` = subshell/group; `<>` = redirection
// (incl. bash /dev/tcp networking and heredocs); backtick + `$` = command/
// parameter/arithmetic substitution (covers `$(`, `${`, `$((`, and a bare
// `$GH_TOKEN`). Single quotes make all of these literal, so jq pipes and JSON
// braces are allowed when single-quoted. Double quotes do NOT neutralize `$`
// or backticks, so they are treated as active.
const SHELL_ACTIVE_METACHARS = new Set(['|', ';', '&', '\n', '\r', '(', ')', '{', '}', '<', '>', '`', '$'])

// Returns true iff `command` is a single simple `gh ...` command: the first
// non-whitespace word is `gh`, and no shell-active metachar appears outside
// single quotes. This is the gate for token injection — see COMPOSITION_REASON.
function isSingleBareGhCommand(command: string): boolean {
  const trimmed = command.trimStart()
  if (!/^gh(\s|$)/.test(trimmed)) return false

  let quote: '"' | "'" | null = null
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === undefined) continue
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      // Inside double quotes `$` and backtick still expand; only `"` closes.
      if (ch === '"') quote = null
      else if (ch === '$' || ch === '`') return false
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (SHELL_ACTIVE_METACHARS.has(ch)) return false
  }
  return quote === null
}

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
  let stripRepoFlag = false
  for (let i = 0; i < ghStarts.length; i++) {
    const start = ghStarts[i] as number
    const end = ghStarts[i + 1] ?? tokens.length
    const args = tokens.slice(start + 1, end)
    const segment = classifyGhSegment(args)
    if (segment.kind === 'block') return segment
    if (segment.kind === 'inject') {
      repoSlugs.push(...segment.repoSlugs)
      if (segment.stripRepoFlag === true) stripRepoFlag = true
    }
  }

  if (repoSlugs.length === 0) return { kind: 'pass-through' }
  const owners = new Set(repoSlugs.map((slug) => slug.split('/')[0]))
  if (owners.size > 1) return { kind: 'block', reason: MULTI_OWNER_REASON }

  // We would inject a token. Enforce the single-bare-`gh` shape: the token
  // lands in the shell's env, so any sibling/upstream/downstream process or
  // shell expansion would inherit it.
  if (!isSingleBareGhCommand(command)) return { kind: 'block', reason: COMPOSITION_REASON }

  if (stripRepoFlag) {
    return { kind: 'inject', repoSlug: repoSlugs[0] as string, rewrittenCommand: stripRepoFlagFromCommand(command) }
  }
  return { kind: 'inject', repoSlug: repoSlugs[0] as string }
}

// Removes an unquoted `-R`/`--repo` flag (and its repo-slug value) from a single
// bare command, preserving everything else byte-for-byte. Quote-aware so a `-R`
// inside a quoted `-f query='...'` value is never touched; a repo slug is
// owner/name (no whitespace), so the value is always a single unquoted token.
// Used only for graphql, where `gh api` rejects the flag we consumed as a hint.
function stripRepoFlagFromCommand(command: string): string {
  let out = ''
  let i = 0
  while (i < command.length) {
    const ch = command[i] as string
    if (ch === '"' || ch === "'") {
      const close = command.indexOf(ch, i + 1)
      const endQuote = close === -1 ? command.length : close
      out += command.slice(i, endQuote + 1)
      i = endQuote + 1
      continue
    }
    const removed = matchRepoFlagAt(command, i)
    if (removed !== null) {
      out = out.replace(/[ \t]+$/, '')
      i = removed
      while (command[i] === ' ' || command[i] === '\t') i += 1
      if (out !== '' && i < command.length) out += ' '
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// If `command` has an unquoted `-R`/`--repo` repo-flag token starting at `start`
// (at a word boundary), returns the index just past the flag and its value;
// otherwise null. Handles `-R o/r`, `--repo o/r`, `-R=o/r`, `--repo=o/r`.
function matchRepoFlagAt(command: string, start: number): number | null {
  const before = start === 0 ? '' : (command[start - 1] as string)
  if (before !== '' && before !== ' ' && before !== '\t') return null

  for (const flag of ['--repo', '-R']) {
    if (!command.startsWith(flag, start)) continue
    let i = start + flag.length
    const sep = command[i]
    if (sep === '=') {
      i += 1
      while (i < command.length && command[i] !== ' ' && command[i] !== '\t') i += 1
      return i
    }
    if (sep === ' ' || sep === '\t') {
      let j = i
      while (command[j] === ' ' || command[j] === '\t') j += 1
      const valueStart = j
      while (j < command.length && command[j] !== ' ' && command[j] !== '\t') j += 1
      if (!isRepoSlug(command.slice(valueStart, j))) return null
      return j
    }
  }
  return null
}

function classifyGhSegment(args: readonly string[]): GhSegmentDecision {
  const subcommand = args.find((t) => !t.startsWith('-'))
  if (subcommand === undefined) return { kind: 'pass-through' }

  // `gh api` is resolved BEFORE the generic -R extraction: for a literal
  // `/repos/{owner}/{repo}` endpoint the request goes to the PATH repo and `gh`
  // ignores -R, so trusting -R here would mint a token for one repo while the
  // call hits another (the allowlist-bypass this guards against).
  if (subcommand === 'api') return classifyGhApiSegment(args)

  const explicit = extractRepoFlag(args)
  if (explicit !== null) return { kind: 'inject', repoSlugs: [explicit] }

  if (REPO_LESS_SUBCOMMANDS.has(subcommand)) return { kind: 'pass-through' }

  return { kind: 'block', reason: MISSING_REPO_REASON }
}

// Repo authority for `gh api`: the literal endpoint path wins. A `-R/--repo`
// that names a DIFFERENT repo than the path is a mint-for-X-but-hit-Y attempt
// and blocks. A placeholder endpoint (`repos/{owner}/{repo}`) has no literal
// target, so -R fills it and is authoritative. A non-repo endpoint without a
// `-R` (`graphql`, `/user`) passes through — the flag is what makes it
// repo-scoped, so absent one there is nothing to mint for.
function classifyGhApiSegment(args: readonly string[]): GhSegmentDecision {
  const pathRepos = extractReposFromApiPath(args)
  const flagRepo = extractRepoFlag(args)

  if (pathRepos.length > 0) {
    if (flagRepo !== null && !pathRepos.includes(flagRepo)) {
      return { kind: 'block', reason: API_REPO_CONFLICT_REASON }
    }
    return { kind: 'inject', repoSlugs: pathRepos }
  }

  if (flagRepo !== null && apiEndpointHasOwnerRepoPlaceholder(args)) {
    return { kind: 'inject', repoSlugs: [flagRepo] }
  }

  // graphql encodes its repo in the query body / opaque node IDs, never an
  // inspectable path, so `-R` is taken as the mint hint. Safe because there is
  // no literal path to conflict with (cf. the API_REPO_CONFLICT_REASON guard
  // above): the minted token's installation scope, not the flag, bounds reach.
  // `gh api` rejects `-R`, so the flag must be stripped from the command.
  if (flagRepo !== null && isGraphqlEndpoint(args)) {
    return { kind: 'inject', repoSlugs: [flagRepo], stripRepoFlag: true }
  }

  return { kind: 'pass-through' }
}

function isGraphqlEndpoint(args: readonly string[]): boolean {
  return findApiEndpoint(args) === 'graphql'
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

// The `gh api` endpoint is the first positional arg after `api` (skipping flags
// and the tokens that bare value-flags consume). Returns null if there is none.
function findApiEndpoint(args: readonly string[]): string | null {
  const apiIndex = args.indexOf('api')
  if (apiIndex === -1) return null
  for (let i = apiIndex + 1; i < args.length; i++) {
    const arg = args[i] as string
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && GH_API_VALUE_FLAGS.has(arg)) i += 1
      continue
    }
    return arg
  }
  return null
}

// Every LITERAL repo the endpoint path targets. Normally one (`/repos/{o}/{r}/…`),
// but a compare endpoint `/repos/{o}/{r}/compare/{base}...{owner}:{branch}` also
// reaches the cross-fork head repo `{owner}/{r}`, so both are returned and must
// be allowlisted. `{owner}/{repo}` placeholder segments are NOT literal targets
// (see apiEndpointHasOwnerRepoPlaceholder) and yield nothing here.
function extractReposFromApiPath(args: readonly string[]): string[] {
  const endpoint = findApiEndpoint(args)
  if (endpoint === null) return []
  const normalized = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
  const segments = normalized.split('/')
  if (segments[0] !== 'repos') return []
  const owner = segments[1]
  const name = segments[2]
  if (owner === undefined || name === undefined) return []
  // A `{owner}`/`{repo}` placeholder is not a literal target; -R fills it.
  if (isPlaceholderSegment(owner) || isPlaceholderSegment(name)) return []
  const baseSlug = `${owner}/${name}`
  if (!isRepoSlug(baseSlug)) return []

  const repos = [baseSlug]
  // compare/{base}...{headOwner}:{headBranch} reaches headOwner's fork.
  const compareIndex = segments.indexOf('compare', 3)
  if (compareIndex !== -1) {
    const spec = segments.slice(compareIndex + 1).join('/')
    const head = spec.split('...')[1]
    const headOwner = head?.includes(':') ? head.split(':')[0] : undefined
    if (headOwner !== undefined && headOwner !== '' && headOwner !== owner) {
      const headSlug = `${headOwner}/${name}`
      if (isRepoSlug(headSlug)) repos.push(headSlug)
    }
  }
  return repos
}

// True when the endpoint uses gh's `{owner}`/`{repo}` template placeholders,
// which `-R/--repo` fills at runtime — so for these, -R is the authoritative
// target rather than a conflicting literal.
function apiEndpointHasOwnerRepoPlaceholder(args: readonly string[]): boolean {
  const endpoint = findApiEndpoint(args)
  if (endpoint === null) return false
  return endpoint.includes('{owner}') || endpoint.includes('{repo}')
}

function isRepoSlug(value: string): boolean {
  const [owner, name, ...rest] = value.split('/')
  return owner !== undefined && owner !== '' && name !== undefined && name !== '' && rest.length === 0
}

function isPlaceholderSegment(segment: string): boolean {
  return segment.includes('{') || segment.includes('}')
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
