export type GhCommandDecision =
  | { kind: 'pass-through' }
  | { kind: 'block'; reason: string }
  | { kind: 'inject'; repoSlug: string }

const BLOCK_REASON =
  'This GitHub App spans multiple owners, so `gh` has no single correct token. ' +
  'Re-run with an explicit repo: `gh <cmd> -R owner/repo` (or `gh api /repos/owner/repo/...`) ' +
  'so the right installation token can be injected.'

// Subcommands that never target a single repo and so need no token injection.
// `gh api` is handled separately: it targets a repo only when its path is a
// /repos/{owner}/{repo}/... shape.
const REPO_LESS_SUBCOMMANDS = new Set([
  'auth',
  'config',
  'extension',
  'extensions',
  'gist',
  'alias',
  'completion',
  'status',
  'org',
  'ssh-key',
  'gpg-key',
  'label',
  'ruleset',
  'accessibility',
])

export function analyzeGhCommand(command: string): GhCommandDecision {
  const tokens = tokenize(command)
  const ghStart = findGhInvocation(tokens)
  if (ghStart === -1) return { kind: 'pass-through' }

  const args = tokens.slice(ghStart + 1)
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

  return { kind: 'block', reason: BLOCK_REASON }
}

function findGhInvocation(tokens: readonly string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === undefined) continue
    // Skip leading `FOO=bar` environment assignments preceding the command.
    if (i === 0 || isCommandBoundaryBefore(tokens, i)) {
      if (token === 'gh') return i
    }
  }
  return -1
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

function extractRepoFromApiPath(args: readonly string[]): string | null {
  for (const arg of args) {
    if (arg.startsWith('-')) continue
    const normalized = arg.startsWith('/') ? arg.slice(1) : arg
    const segments = normalized.split('/')
    if (segments[0] === 'repos' && segments[1] !== undefined && segments[2] !== undefined) {
      const slug = `${segments[1]}/${segments[2]}`
      if (isRepoSlug(slug)) return slug
    }
  }
  return null
}

function isRepoSlug(value: string): boolean {
  const [owner, name, ...rest] = value.split('/')
  return owner !== undefined && owner !== '' && name !== undefined && name !== '' && rest.length === 0
}

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasContent = false
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
      if (hasContent) {
        tokens.push(current)
        current = ''
        hasContent = false
      }
      continue
    }
    current += ch
    hasContent = true
  }
  if (hasContent) tokens.push(current)
  return tokens
}
