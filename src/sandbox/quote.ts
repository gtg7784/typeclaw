// POSIX shell quoting for rendering a bwrap argv array into a single
// `bash -c`-safe string. Today's bash tool accepts a string `command` slot
// (`mutableArgs.command`), so the sandbox primitive renders its canonical
// argv into a quoted string the agent runtime can drop in unchanged.
//
// This is a local copy of the same helper in `src/update/index.ts`. It is
// deliberately not promoted to a shared module yet: two call sites do not
// justify the coupling, and this primitive is meant to stand alone with zero
// imports from the rest of the tree. Promote to `src/shared/shell.ts` only
// when a third independent consumer appears.
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg
  return `'${arg.replaceAll("'", "'\\''")}'`
}

export function formatCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ')
}
