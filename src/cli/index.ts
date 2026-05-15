#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'

import { CLI_VERSION } from '../init/cli-version'

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
    doctor: () => import('./doctor').then((m) => m.doctorCommand),
    usage: () => import('./usage').then((m) => m.usageCommand),
    _hostd: () => import('./hostd').then((m) => m.hostdCommand),
  },
})

runMain(main)
