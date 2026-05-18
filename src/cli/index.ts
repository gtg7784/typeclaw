#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { CLI_VERSION } from '../init/cli-version'
import { dispatchPluginCommand, type PluginCommandDispatchOutcome } from './plugin-commands-dispatch'

const BUILTIN_NAMES = [
  'init',
  'run',
  'tui',
  'start',
  'stop',
  'restart',
  'status',
  'reload',
  'logs',
  'shell',
  'compose',
  'channel',
  'role',
  'provider',
  'model',
  'doctor',
  'usage',
  '_hostd',
] as const

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
    shell: () => import('./shell').then((m) => m.shellCommand),
    compose: () => import('./compose').then((m) => m.composeCommand),
    channel: () => import('./channel').then((m) => m.channelCommand),
    role: () => import('./role').then((m) => m.roleCommand),
    provider: () => import('./provider').then((m) => m.providerCommand),
    model: () => import('./model').then((m) => m.modelCommand),
    doctor: () => import('./doctor').then((m) => m.doctorCommand),
    usage: () => import('./usage').then((m) => m.usageCommand),
    _hostd: () => import('./hostd').then((m) => m.hostdCommand),
  },
})

await runWithPluginDispatch()

async function runWithPluginDispatch(): Promise<void> {
  const argv = process.argv.slice(2)
  const first = argv[0]

  if (first === '--help' || first === '-h' || first === undefined) {
    const { renderPluginCommandsSection } = await import('./plugin-command-help')
    const { discoverCommands } = await import('./plugin-commands')
    await runMain(main)
    const discovery = await discoverCommands({ cwd: process.cwd() })
    const section = renderPluginCommandsSection(discovery.commands)
    if (section !== null) process.stdout.write(`\n${section}\n`)
    return
  }

  if (!first.startsWith('-') && !BUILTIN_NAMES.includes(first as (typeof BUILTIN_NAMES)[number])) {
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
