#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { CLI_VERSION } from '../init/cli-version'
import { findAgentDir } from '../init/find-agent-dir'
import { runStartupMigrations } from '../migrations'
import { BUILTIN_COMMAND_NAMES } from './builtins'
import type { PluginCommandDispatchOutcome } from './plugin-commands-dispatch'

const main = defineCommand({
  meta: {
    name: 'typeclaw',
    version: CLI_VERSION,
    description: 'TypeClaw agent runtime',
  },
  subCommands: {
    init: () => import('./init').then((m) => m.init),
    run: () => import('./run').then((m) => m.run),
    tui: () => import('./tui').then((m) => m.tui),
    start: () => import('./start').then((m) => m.startCommand),
    stop: () => import('./stop').then((m) => m.stopCommand),
    restart: () => import('./restart').then((m) => m.restartCommand),
    status: () => import('./status').then((m) => m.statusCommand),
    reload: () => import('./reload').then((m) => m.reload),
    logs: () => import('./logs').then((m) => m.logsCommand),
    inspect: () => import('./inspect').then((m) => m.inspectCommand),
    memory: () => import('./memory').then((m) => m.memoryCommand),
    shell: () => import('./shell').then((m) => m.shellCommand),
    compose: () => import('./compose').then((m) => m.composeCommand),
    channel: () => import('./channel').then((m) => m.channelCommand),
    cron: () => import('./cron').then((m) => m.cronCommand),
    tunnel: () => import('./tunnel').then((m) => m.tunnelCommand),
    role: () => import('./role').then((m) => m.roleCommand),
    provider: () => import('./provider').then((m) => m.providerCommand),
    mcp: () => import('./mcp').then((m) => m.mcpCommand),
    model: () => import('./model').then((m) => m.modelCommand),
    mount: () => import('./mount').then((m) => m.mountCommand),
    doctor: () => import('./doctor').then((m) => m.doctorCommand),
    usage: () => import('./usage').then((m) => m.usageCommand),
    update: () => import('./update').then((m) => m.updateCommand),
    _hostd: () => import('./hostd').then((m) => m.hostdCommand),
    '_update-check': () => import('./update-check').then((m) => m.updateCheckCommand),
  },
})

// #673's v1->v2 secrets migration was wired only into the container-stage boot
// path (src/run/index.ts), so host CLI commands that read secrets.json directly
// (model/provider list -> tryReadProvidersSync -> v2-only parser) still hard-fail
// on a never-booted v1 folder. Run it once per host invocation here — at the
// dispatch boundary, NOT in the parse path, which would recreate the read-time
// shim #638 deliberately removed.
let hostStartupMigrationsDone = false

// `run` is the container stage and owns its own migration. Bare flag
// invocations (`--help`, `-h`, `--version`, `-v`, no command) are
// informational, exit before reading secrets, and must NOT rewrite secrets.json
// or emit migration warnings — so only a real subcommand triggers the migration.
function shouldRunHostStartupMigrations(commandName: string | undefined): boolean {
  if (commandName === undefined || commandName === 'run') return false
  return !commandName.startsWith('-')
}

function runHostStartupMigrationsOnce(commandName: string | undefined): void {
  if (hostStartupMigrationsDone) return
  hostStartupMigrationsDone = true
  if (!shouldRunHostStartupMigrations(commandName)) return
  const agentDir = findAgentDir(process.cwd())
  if (agentDir === null) return
  try {
    runStartupMigrations(agentDir)
  } catch (err) {
    // runStartupMigrations isolates per-migration throws; this guards only the
    // unexpected so a migration error can never block the host command itself.
    console.warn(`[migration] host startup migration error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Plugin commands are discovered from the agent folder; outside one, discovery
// yields nothing and no section prints. Shared by the --help and no-command
// paths so both keep showing plugin commands above the builtin usage table.
async function printPluginCommandsSection(): Promise<void> {
  const { renderPluginCommandsSection } = await import('./plugin-command-help')
  const { discoverCommands } = await import('./plugin-commands')
  const discovery = await discoverCommands({ cwd: process.cwd() })
  const section = renderPluginCommandsSection(discovery.commands)
  if (section !== null) process.stdout.write(`${section}\n\n`)
}

async function runWithPluginDispatch(): Promise<void> {
  const argv = process.argv.slice(2)
  const first = argv[0]

  runHostStartupMigrationsOnce(first)

  // Disk-only read + detached background refresh; fail-open and never blocks the
  // command. The suppression check is dependency-free and runs FIRST so a bare
  // flag or plugin command never imports update-notify (which eagerly loads
  // @/config). See src/cli/update-suppression.ts and src/cli/update-notify.ts.
  const { shouldConsiderUpdateNotice } = await import('./update-suppression')
  if (shouldConsiderUpdateNotice(first)) {
    const { maybeNotifyUpdate } = await import('./update-notify')
    await maybeNotifyUpdate(first)
  }

  // Top-level help and the no-command case are hand-rendered from the static
  // command-meta table (see ./help) instead of `runMain(main)`. Routing them
  // through citty would resolve every lazy `subCommands` thunk just to read the
  // descriptions for the usage table, importing all 25 command modules (and
  // their config/docker/agent-messenger graphs) — which made a bare `typeclaw`
  // slower than running a real subcommand. Per-command help (`typeclaw x --help`)
  // still goes through citty below, importing only that one command.
  if (first === '--help' || first === '-h') {
    await printPluginCommandsSection()
    const { renderTopLevelUsage } = await import('./help')
    process.stdout.write(`${await renderTopLevelUsage()}\n\n`)
    process.exit(0)
  }

  if (first === undefined) {
    // No plugin discovery here: bare `typeclaw` must stay a pure
    // E_NO_COMMAND report and never load plugin/config code (discoverCommands
    // can rewrite typeclaw.json via loadConfigSync). Plugin commands surface
    // only on explicit top-level help and plugin-command dispatch. Mirror
    // citty's E_NO_COMMAND: usage to stdout, the message to stderr, exit 1.
    const { renderTopLevelUsage } = await import('./help')
    process.stdout.write(`${await renderTopLevelUsage()}\n\n`)
    process.stderr.write('No command specified.\n')
    process.exit(1)
  }

  if (
    first !== undefined &&
    !first.startsWith('-') &&
    !BUILTIN_COMMAND_NAMES.includes(first as (typeof BUILTIN_COMMAND_NAMES)[number])
  ) {
    // Lazy: the dispatch chain statically pulls in @/config, @/plugin, zod, and
    // @/container (~190ms). Only plugin (non-builtin) commands need it, so we
    // defer the import to keep builtin commands and bare flags fast.
    const { dispatchPluginCommand } = await import('./plugin-commands-dispatch')
    const outcome = await dispatchPluginCommand({ name: first, rawArgs: argv.slice(1), cwd: process.cwd() })
    if (outcome.kind === 'dispatched') {
      process.exit(outcome.exitCode)
    }
    if (outcome.kind === 'error') {
      process.stderr.write(`${outcome.message}\n`)
      process.exit(outcome.exitCode)
    }
    // outcome.kind === 'not-found' → fall through to citty for unknown-command error
  }
  await runMain(main)
}

export type { PluginCommandDispatchOutcome }

await runWithPluginDispatch()
