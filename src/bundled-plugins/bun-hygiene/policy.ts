import { ACKNOWLEDGE_GUARDS, type GuardBlock, isGuardAcknowledged } from '../guard/policy'

export const GUARD_GLOBAL_INSTALL = 'globalInstall'
export const GUARD_NON_BUN_PACKAGE_MANAGER = 'nonBunPackageManager'

const NON_BUN_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn'])
const INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'add'])

export function checkBunHygieneGuard(options: { tool: string; args: Record<string, unknown> }): GuardBlock | undefined {
  const { tool, args } = options
  if (tool !== 'bash') return undefined

  const command = args.command
  if (typeof command !== 'string') return undefined

  const verdict = classify(command)
  if (verdict === undefined) return undefined
  if (verdict.kind === 'global-install') return blockGlobalInstall(verdict.label, args)
  return blockNonBunManager(verdict.manager, args)
}

type Verdict = { kind: 'global-install'; label: string } | { kind: 'non-bun'; manager: string }

// Why a segment model instead of one big regex: every gap in a raw-string match
// is a shell-structure gap. Splitting into segments first means a global flag on
// a *different* command (`npm install\n-g x` — two commands) can never combine
// with an install on another, leading assignment words (`FOO=bar npm ...`) are
// stripped uniformly, and `--global=false` is inspected as a real token. The
// global-install verdict wins over the plain non-bun verdict (it's the more
// specific violation, and acknowledging it is meant to let the whole thing run).
function classify(command: string): Verdict | undefined {
  let fallback: Verdict | undefined
  for (const segment of splitSegments(command)) {
    const words = segment.map(normalizeWord)
    const manager = leadingCommandWord(words)
    if (manager === undefined) continue

    // `bun` is the allowed manager, but a `bun add -g` still installs to ~/.bun
    // (outside /agent) and is wiped on restart, so it is a global install too —
    // just never a plain non-bun violation.
    const isBun = manager === 'bun'
    if (!isBun && !NON_BUN_MANAGERS.has(manager)) continue

    const label = globalInstallLabel(manager, words)
    if (label !== undefined) return { kind: 'global-install', label }
    if (!isBun) fallback ??= { kind: 'non-bun', manager }
  }
  return fallback
}

// Split on real command separators (`;`, `&&`, `||`, `|`, `&`, newline, `\r`)
// and on subshell / command-substitution openers (`(`, `$(`, backtick), then
// tokenize each segment into whitespace-separated words. Quote-aware so a
// separator inside quotes stays literal; backslash escapes the next character
// (so `\;` and `\ ` are literal, not separators/breaks). Word-level only — it
// does not interpret redirections or expansions beyond boundary marking.
function splitSegments(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let current = ''
  let hasWord = false
  let quote: '"' | "'" | null = null

  const flushWord = (): void => {
    if (hasWord) {
      words.push(current)
      current = ''
      hasWord = false
    }
  }
  const flushSegment = (): void => {
    flushWord()
    if (words.length > 0) {
      segments.push(words)
      words = []
    }
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      else {
        current += ch
        hasWord = true
      }
      continue
    }
    if (ch === '\\') {
      const next = command[i + 1]
      if (next === undefined) break
      current += next
      hasWord = true
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasWord = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flushWord()
      continue
    }
    if (ch === '\n' || ch === '\r' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === '`') {
      flushSegment()
      continue
    }
    if (ch === '$' && command[i + 1] === '(') {
      flushSegment()
      i++
      continue
    }
    current += ch
    hasWord = true
  }
  flushSegment()
  return segments
}

// A word is already quote/escape-collapsed by splitSegments (quotes consumed,
// backslash-escapes literalized), so the only residue to strip is leftover
// quote characters that appeared mid-token via concatenation. Keeping this
// explicit makes `"npm"`, `n\px`, `'npm'` all resolve to their bare binary.
function normalizeWord(word: string): string {
  return word.replaceAll('"', '').replaceAll("'", '')
}

// The command word is the first token that is not a shell preamble: `sudo`,
// `env`, `command`/`exec`/`nice`, or a `VAR=val` assignment. This is what makes
// `FOO=bar npm install` resolve to `npm` instead of evading the guard.
function leadingCommandWord(words: string[]): string | undefined {
  for (const word of words) {
    if (word === 'sudo' || word === 'env' || word === 'command' || word === 'exec' || word === 'nice') continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    return word
  }
  return undefined
}

function globalInstallLabel(manager: string, words: string[]): string | undefined {
  if (manager === 'yarn') {
    return words.includes('global') && words.includes('add') ? 'yarn global add' : undefined
  }
  const hasInstall = words.some((w) => INSTALL_SUBCOMMANDS.has(w))
  const hasGlobal = words.some(isGlobalFlag)
  if (!hasInstall || !hasGlobal) return undefined
  return manager === 'bun' ? 'bun global install (-g / --global)' : 'npm/pnpm global install (-g / --global)'
}

// `-g` / `--global`, including bundled short flags like `-gD` / `-Dg`. An
// explicit falsy value (`--global=false|0|no|off`) is NOT a global install —
// it disables the flag — so it must not match.
function isGlobalFlag(word: string): boolean {
  if (/^--global=(?:false|0|no|off)$/i.test(word)) return false
  if (/^--global(?:=|$)/.test(word)) return true
  return /^-[A-Za-z]*g[A-Za-z]*$/.test(word)
}

function blockGlobalInstall(label: string, args: Record<string, unknown>): GuardBlock | undefined {
  if (isGuardAcknowledged(args, GUARD_GLOBAL_INSTALL)) return undefined

  return {
    block: true,
    reason: [
      `Guard \`${GUARD_GLOBAL_INSTALL}\` blocked a global install: ${label}.`,
      'Global installs live outside the bind-mounted /agent folder and are wiped on every container restart, so they never persist.',
      'Use `bun add <pkg>` to add a dependency that survives restarts (it writes package.json), or `bunx <pkg>` to run a tool once without installing.',
      `Retry with \`${ACKNOWLEDGE_GUARDS}.${GUARD_GLOBAL_INSTALL}: true\` only if a throwaway global install is genuinely what you want.`,
    ].join(' '),
  }
}

function blockNonBunManager(manager: string, args: Record<string, unknown>): GuardBlock | undefined {
  if (isGuardAcknowledged(args, GUARD_NON_BUN_PACKAGE_MANAGER)) return undefined

  return {
    block: true,
    reason: [
      `Guard \`${GUARD_NON_BUN_PACKAGE_MANAGER}\` blocked \`${manager}\`. This container standardizes on bun.`,
      'Use `bun install` / `bun add <pkg>` instead of npm/pnpm/yarn, and `bunx <pkg>` instead of npx/pnpx.',
      `Retry with \`${ACKNOWLEDGE_GUARDS}.${GUARD_NON_BUN_PACKAGE_MANAGER}: true\` if this package manager is genuinely required (e.g. a project pinned to a different lockfile).`,
    ].join(' '),
  }
}
