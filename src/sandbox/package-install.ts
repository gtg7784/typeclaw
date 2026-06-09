// Recognizes the narrow command class that earns the package-install sandbox
// mode (RW project root). Deliberately conservative: a single standalone local
// `bun add` / `bun install` / `bun i` with NO shell metacharacters, chaining,
// redirects, or substitution. Anything fancier (`bun add x && rm -rf …`,
// `bun add x; curl …`, a subshell, a pipe) falls back to the default ro-root
// jail so the broad RW root can never be piggybacked onto an attacker-controlled
// second command. Global installs (`-g` / `--global`) are excluded — the
// bun-hygiene guard already blocks them and they write outside the jail anyway.
const SHELL_METACHARACTERS = /[;&|`$()<>\\\n\r{}!*?[\]"']/

const GLOBAL_FLAG = /^(-g|--global)$/

export function isPackageInstallCommand(command: string): boolean {
  if (SHELL_METACHARACTERS.test(command)) return false

  const words = command.trim().split(/\s+/)
  if (words[0] !== 'bun') return false

  const subcommand = words[1]
  if (subcommand !== 'add' && subcommand !== 'install' && subcommand !== 'i') return false

  return !words.some((word) => GLOBAL_FLAG.test(word))
}
