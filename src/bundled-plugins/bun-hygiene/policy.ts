import { ACKNOWLEDGE_GUARDS, type GuardBlock, isGuardAcknowledged } from '../guard/policy'

export const GUARD_GLOBAL_INSTALL = 'globalInstall'
export const GUARD_NON_BUN_PACKAGE_MANAGER = 'nonBunPackageManager'

// Regex-on-raw-string (like the sibling secret-exfil guard): match a package
// manager only at a command boundary — start of line or after a separator that
// begins a new simple command. This boundary is what stops `my-npm-wrapper`,
// `./npm`, and `echo "npm install"` from matching.
const COMMAND_BOUNDARY = String.raw`(?:^|[\n;&|(\`]|&&|\|\||\$\()\s*`

// Allow an optional `sudo` / `env VAR=...` preamble so `env FOO=bar npm ...`
// still resolves to the npm command behind it.
const COMMAND_PREAMBLE = String.raw`(?:sudo\s+)?(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+)?`

const NON_BUN_MANAGERS = ['npm', 'npx', 'pnpm', 'pnpx', 'yarn'] as const

const GLOBAL_INSTALL_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  {
    // npm/pnpm: `install`/`i`/`add` somewhere on the line together with a global
    // flag (`-g` or `--global`, including bundled short flags like `-gD`).
    pattern: new RegExp(
      `${COMMAND_BOUNDARY}${COMMAND_PREAMBLE}(?:npm|pnpm)\\s+(?:install|i|add)\\b[^\\n;&|]*\\s-(?:-global\\b|[A-Za-z]*g[A-Za-z]*\\b)`,
    ),
    label: 'npm/pnpm global install (-g / --global)',
  },
  {
    // Same, but the global flag precedes the subcommand: `npm -g install x`.
    pattern: new RegExp(
      `${COMMAND_BOUNDARY}${COMMAND_PREAMBLE}(?:npm|pnpm)\\s+-(?:-global\\b|[A-Za-z]*g[A-Za-z]*\\b)[^\\n;&|]*\\s(?:install|i|add)\\b`,
    ),
    label: 'npm/pnpm global install (-g / --global)',
  },
  {
    pattern: new RegExp(`${COMMAND_BOUNDARY}${COMMAND_PREAMBLE}yarn\\s+global\\s+add\\b`),
    label: 'yarn global add',
  },
  {
    // `bun add -g` / `bun install -g` / `bun add --global`. Bun globals live in
    // ~/.bun outside the bind-mounted /agent, so they vanish on restart just
    // like the others.
    pattern: new RegExp(
      `${COMMAND_BOUNDARY}${COMMAND_PREAMBLE}bun\\s+(?:add|install|i)\\b[^\\n;&|]*\\s-(?:-global\\b|[A-Za-z]*g[A-Za-z]*\\b)`,
    ),
    label: 'bun global install (-g / --global)',
  },
]

const NON_BUN_MANAGER_PATTERN = new RegExp(`${COMMAND_BOUNDARY}${COMMAND_PREAMBLE}(${NON_BUN_MANAGERS.join('|')})\\b`)

export function checkBunHygieneGuard(options: { tool: string; args: Record<string, unknown> }): GuardBlock | undefined {
  const { tool, args } = options
  if (tool !== 'bash') return undefined

  const command = args.command
  if (typeof command !== 'string') return undefined

  const globalInstall = matchGlobalInstall(command)
  if (globalInstall) return blockGlobalInstall(globalInstall, args)

  return checkNonBunManager(command, args)
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
