// MUST stay free of command-module imports. `src/cli/index.ts` hand-renders the
// top-level help table from this data so a bare `typeclaw`/`--help` does not make
// citty resolve all 25 lazy `subCommands` thunks (each pulling the full
// config/docker/agent-messenger graph) just to read their descriptions — the
// resolve-all-for-help path was why a bare invocation was slower than a real
// subcommand. Each command module keeps its own literal `meta.description` (what
// citty prints for `typeclaw <cmd> --help`); the descriptions here are a separate
// copy, and `command-meta.test.ts` asserts the two stay byte-identical so the
// top-level table and per-command help cannot drift.

export type BuiltinCommandName =
  | 'init'
  | 'run'
  | 'tui'
  | 'start'
  | 'stop'
  | 'restart'
  | 'status'
  | 'reload'
  | 'logs'
  | 'inspect'
  | 'dreams'
  | 'shell'
  | 'compose'
  | 'channel'
  | 'cron'
  | 'tunnel'
  | 'role'
  | 'provider'
  | 'model'
  | 'mount'
  | 'doctor'
  | 'usage'
  | 'update'
  | '_hostd'
  | '_update-check'

export type BuiltinCommandMeta = {
  name: BuiltinCommandName
  description: string
  hidden?: boolean
}

export const BUILTIN_COMMANDS: readonly BuiltinCommandMeta[] = [
  { name: 'init', description: 'initialize a new typeclaw agent in the current directory' },
  { name: 'run', description: 'run the agent in the foreground (container stage)' },
  { name: 'tui', description: 'open the live agent session in the read+write viewer (host stage)' },
  { name: 'start', description: 'launch the agent container in the background (host stage)' },
  { name: 'stop', description: 'stop the agent container (host stage)' },
  { name: 'restart', description: 'stop and relaunch the agent container (host stage)' },
  { name: 'status', description: 'show the agent container and host daemon status (host stage)' },
  { name: 'reload', description: "reload the running agent's reloadable subsystems (cron, ...)" },
  { name: 'logs', description: 'show the agent container logs (host stage)' },
  {
    name: 'inspect',
    description: 'session viewer: pick a session, the live TUI, or container logs to observe (host stage)',
  },
  {
    name: 'dreams',
    description: "browse the dreaming subagent's memory-consolidation journal from git history (host stage)",
  },
  { name: 'shell', description: 'open an interactive shell in the agent container (host stage)' },
  { name: 'compose', description: 'orchestrate every typeclaw agent in immediate subdirectories of cwd' },
  { name: 'channel', description: 'manage channel adapters wired into the agent' },
  {
    name: 'cron',
    description: 'inspect cron jobs registered in the running agent (user-authored + plugin-contributed)',
  },
  { name: 'tunnel', description: 'manage public tunnels for channels and manual upstreams' },
  { name: 'role', description: 'manage role memberships on this agent' },
  { name: 'provider', description: 'manage LLM provider credentials in secrets.json' },
  { name: 'model', description: 'manage model profiles in typeclaw.json (models.default, models.fast, …)' },
  { name: 'mount', description: 'manage host files and directories mounted into the agent container' },
  { name: 'doctor', description: 'diagnose the host, agent folder, and plugins; surface remediation steps' },
  { name: 'usage', description: 'report LLM token usage and cost for this agent folder' },
  { name: 'update', description: 'update the installed typeclaw CLI (auto-detects global vs local)' },
  { name: '_hostd', description: 'internal: host-side typeclaw daemon (do not invoke directly)', hidden: true },
  {
    name: '_update-check',
    description: 'internal: refresh the typeclaw version cache (do not invoke directly)',
    hidden: true,
  },
]

export const BUILTIN_COMMAND_NAMES: readonly BuiltinCommandName[] = BUILTIN_COMMANDS.map((c) => c.name)

const DESCRIPTION_BY_NAME: ReadonlyMap<string, string> = new Map(BUILTIN_COMMANDS.map((c) => [c.name, c.description]))

export function getBuiltinCommandDescription(name: BuiltinCommandName): string {
  const description = DESCRIPTION_BY_NAME.get(name)
  if (description === undefined) throw new Error(`unknown builtin command: ${name}`)
  return description
}
