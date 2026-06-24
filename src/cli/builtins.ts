// Stable, dependency-free re-export of the top-level `typeclaw` subcommand names
// that the CLI dispatches via citty. Plugin commands MUST NOT shadow these names.
// `src/cli/index.ts` consumes this for argv interception; `src/plugin/registry.ts`
// consumes it to reject plugin commands that collide. The names (and their help
// descriptions) are defined in `./command-meta`.
export { BUILTIN_COMMAND_NAMES } from './command-meta'
export type { BuiltinCommandName } from './command-meta'
