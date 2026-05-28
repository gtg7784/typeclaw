#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { CLI_VERSION } from '../init/cli-version'
import { BUILTIN_COMMAND_NAMES } from './builtins'
import { dispatchPluginCommand, type PluginCommandDispatchOutcome } from './plugin-commands-dispatch'

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
    shell: () => import('./shell').then((m) => m.shellCommand),
    compose: () => import('./compose').then((m) => m.composeCommand),
    channel: () => import('./channel').then((m) => m.channelCommand),
    cron: () => import('./cron').then((m) => m.cronCommand),
    tunnel: () => import('./tunnel').then((m) => m.tunnelCommand),
    role: () => import('./role').then((m) => m.roleCommand),
    provider: () => import('./provider').then((m) => m.providerCommand),
    model: () => import('./model').then((m) => m.modelCommand),
    doctor: () => import('./doctor').then((m) => m.doctorCommand),
    usage: () => import('./usage').then((m) => m.usageCommand),
    update: () => import('./update').then((m) => m.updateCommand),
    _hostd: () => import('./hostd').then((m) => m.hostdCommand),
  },
})

await runWithPluginDispatch()

async function runWithPluginDispatch(): Promise<void> {
  const argv = process.argv.slice(2)
  const first = argv[0]

  if (first === '--help' || first === '-h') {
    // citty calls process.exit() after rendering help, so anything we print
    // AFTER `runMain(main)` is never reached. Print the plugin commands
    // section first; citty's own help follows and the user reads top-down.
    const { renderPluginCommandsSection } = await import('./plugin-command-help')
    const { discoverCommands } = await import('./plugin-commands')
    const discovery = await discoverCommands({ cwd: process.cwd() })
    const section = renderPluginCommandsSection(discovery.commands)
    if (section !== null) process.stdout.write(`${section}\n\n`)
    await runMain(main)
    return
  }

  if (
    first !== undefined &&
    !first.startsWith('-') &&
    !BUILTIN_COMMAND_NAMES.includes(first as (typeof BUILTIN_COMMAND_NAMES)[number])
  ) {
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
