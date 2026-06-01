import { ACKNOWLEDGE_GUARDS, type GuardBlock, isGuardAcknowledged } from '../guard/policy'

export const GUARD_GLOBAL_INSTALL = 'globalInstall'
export const GUARD_NON_BUN_PACKAGE_MANAGER = 'nonBunPackageManager'

// The shell strips quotes and backslash escapes before deciding which binary to
// run, so `\npm`, `"npm"`, `'npm'`, and `n\px` all execute the real npm/npx.
// Matching the raw string misses every one of those. We can't unquote the whole
// command (that would turn `echo "npm install"` into a blockable string), so we
// only neutralize the escapes/quotes while preserving every other character and
// all whitespace — the command-boundary anchoring in the regexes then still
// decides whether the manager is at command position vs inside an argument.
//
// `\<space>` collapses to a space (it's a literal space, not an escape that
// glues a token), every other `\x` collapses to `x`, and quote characters are
// dropped. A trailing lone backslash is dropped. This is normalization for
// detection only; the original command is never executed from this string.
function normalizeShellWords(command: string): string {
  let out = ''
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === '\\') {
      const next = command[i + 1]
      if (next === undefined) break
      out += next === ' ' || next === '\t' || next === '\n' ? ' ' : next
      i++
      continue
    }
    if (ch === '"' || ch === "'") continue
    out += ch
  }
  return out
}

// Regex-on-raw-string (like the sibling secret-exfil guard): match a package
// manager only at a command boundary — start of line or after a separator that
// begins a new simple command. This boundary is what stops `my-npm-wrapper`,
// `./npm`, and `echo "npm install"` from matching.
const COMMAND_BOUNDARY = String.raw`(?:^|[\n;&|(\`]|&&|\|\||\$\()\s*`

// Allow an optional `sudo` / `env VAR=...` preamble so `env FOO=bar npm ...`
// still resolves to the npm command behind it.
const COMMAND_PREAMBLE = String.raw`(?:sudo\s+)?(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+)?`

const NON_BUN_MANAGERS = ['npm', 'npx', 'pnpm', 'pnpx', 'yarn'] as const

// Zero or more whole extra tokens within the same simple command (no segment
// separator), each preceded by whitespace. Lets options sit anywhere between
// the manager and its subcommand/global flag, e.g. `npm --prefix /tmp install
// -g x` or `npm install --foo -g x`, while still requiring real token breaks.
const EXTRA_TOKENS = String.raw`(?:\s+[^\s;&|]+)*?`

// `-g` / `--global`, including bundled short flags like `-gD` / `-Dg`. Anchored
// to a token start (preceding whitespace) so it never matches mid-word.
const GLOBAL_FLAG = String.raw`-(?:-global\b|[A-Za-z]*g[A-Za-z]*\b)`

const INSTALL_SUBCOMMAND = String.raw`(?:install|i|add)\b`

function globalInstallPattern(manager: string): RegExp {
  // Two orderings within the same command: subcommand-then-flag and
  // flag-then-subcommand. Either proves an intent to install globally. Extra
  // tokens may appear before, between, and after the two anchors.
  const head = `${COMMAND_BOUNDARY}${COMMAND_PREAMBLE}${manager}${EXTRA_TOKENS}\\s+`
  return new RegExp(
    `${head}(?:${INSTALL_SUBCOMMAND}${EXTRA_TOKENS}\\s+${GLOBAL_FLAG}` +
      `|${GLOBAL_FLAG}${EXTRA_TOKENS}\\s+${INSTALL_SUBCOMMAND})`,
  )
}

const GLOBAL_INSTALL_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: globalInstallPattern('(?:npm|pnpm)'), label: 'npm/pnpm global install (-g / --global)' },
  {
    pattern: new RegExp(`${COMMAND_BOUNDARY}${COMMAND_PREAMBLE}yarn${EXTRA_TOKENS}\\s+global\\s+add\\b`),
    label: 'yarn global add',
  },
  // bun globals live in ~/.bun outside the bind-mounted /agent, so they vanish
  // on restart just like the others.
  { pattern: globalInstallPattern('bun'), label: 'bun global install (-g / --global)' },
]

const NON_BUN_MANAGER_PATTERN = new RegExp(`${COMMAND_BOUNDARY}${COMMAND_PREAMBLE}(${NON_BUN_MANAGERS.join('|')})\\b`)

export function checkBunHygieneGuard(options: { tool: string; args: Record<string, unknown> }): GuardBlock | undefined {
  const { tool, args } = options
  if (tool !== 'bash') return undefined

  const command = args.command
  if (typeof command !== 'string') return undefined

  const normalized = normalizeShellWords(command)

  const globalInstall = matchGlobalInstall(normalized)
  if (globalInstall) return blockGlobalInstall(globalInstall, args)

  return checkNonBunManager(normalized, args)
}

function matchGlobalInstall(command: string): string | undefined {
  return GLOBAL_INSTALL_PATTERNS.find(({ pattern }) => pattern.test(command))?.label
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

function checkNonBunManager(command: string, args: Record<string, unknown>): GuardBlock | undefined {
  if (isGuardAcknowledged(args, GUARD_NON_BUN_PACKAGE_MANAGER)) return undefined

  const matched = NON_BUN_MANAGER_PATTERN.exec(command)
  if (!matched) return undefined

  const manager = matched[1]
  return {
    block: true,
    reason: [
      `Guard \`${GUARD_NON_BUN_PACKAGE_MANAGER}\` blocked \`${manager}\`. This container standardizes on bun.`,
      'Use `bun install` / `bun add <pkg>` instead of npm/pnpm/yarn, and `bunx <pkg>` instead of npx/pnpx.',
      `Retry with \`${ACKNOWLEDGE_GUARDS}.${GUARD_NON_BUN_PACKAGE_MANAGER}: true\` if this package manager is genuinely required (e.g. a project pinned to a different lockfile).`,
    ].join(' '),
  }
}
