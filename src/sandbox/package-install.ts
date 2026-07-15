// The bun subcommands whose work (or whose spawned child) reads the kernel-backed
// /proc/self/{fd,maps} magic symlinks: package installs (add/install/i), the
// package runners (x/create), and `run` (which can exec a package bin). Under the
// degraded `tmpfs` /proc strategy those reads return ENOTDIR and Bun aborts with
// its opaque "NotDir". `bunx` is the bare-binary alias for `bun x`.
const REAL_PROC_BUN_SUBCOMMANDS = new Set(['add', 'install', 'i', 'x', 'create', 'run'])

// Splits a command line at the shell operators that begin a NEW simple command —
// `&&`, `||`, `;`, `|`, `|&`, `&`, newline — and the subshell opener `(`. A bun
// invocation after a prelude (`cd app && bun install`, `mkdir a; cd a; bunx foo`)
// starts a fresh segment, so checking each segment's head catches it where a
// whole-string `words[0]` check would not. Coarse on purpose: it over-splits
// inside quotes/`$()`, but this only feeds the DIAGNOSTIC below, never a privilege
// decision, so a spurious extra segment can only make the error message MORE
// likely, never widen the sandbox.
const SHELL_COMMAND_SEPARATOR = /(?:&&|\|\||[;|&\n()])+/

// Whether a command will exercise the real /proc, so a caller can turn the
// degraded-mode `tmpfs` fallback into an actionable diagnostic instead of letting
// Bun surface its opaque "NotDir". This is a DIAGNOSTIC heuristic, not a
// privilege gate — it deliberately fires through shell
// metacharacters and chained preludes (a `cd app && bunx foo` still runs bunx) and
// never widens the sandbox surface, so erring toward catching more only improves
// the error message. It is not an authorization boundary.
export function commandNeedsRealProc(command: string): boolean {
  return command.split(SHELL_COMMAND_SEPARATOR).some((segment) => segmentInvokesRealProcBun(segment.trim()))
}

function segmentInvokesRealProcBun(segment: string): boolean {
  if (segment === 'bunx' || segment.startsWith('bunx ')) return true
  const words = segment.split(/\s+/)
  if (words[0] !== 'bun') return false
  return words[1] !== undefined && REAL_PROC_BUN_SUBCOMMANDS.has(words[1])
}
